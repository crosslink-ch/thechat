use serde::Serialize;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

const MAX_ATTACHMENT_DOWNLOAD_BYTES: usize = 25 * 1024 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentDownloadResult {
    saved_path: String,
    transferred_bytes: usize,
    http_status: u16,
}

#[tauri::command]
#[tracing::instrument(skip_all)]
pub async fn download_attachment_to_file(
    url: String,
    suggested_file_name: Option<String>,
) -> Result<AttachmentDownloadResult, String> {
    let parsed =
        url::Url::parse(&url).map_err(|_| "Invalid attachment download URL".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("Unsupported attachment download URL".to_string());
    }

    let response = reqwest::Client::new()
        .get(parsed)
        .send()
        .await
        .map_err(|_| "Attachment download request failed".to_string())?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!(
            "Attachment download failed with status {}",
            status.as_u16()
        ));
    }
    if response
        .content_length()
        .is_some_and(|size| size > MAX_ATTACHMENT_DOWNLOAD_BYTES as u64)
    {
        return Err("Attachment download exceeded the size limit".to_string());
    }

    let bytes = response
        .bytes()
        .await
        .map_err(|_| "Attachment download body failed".to_string())?;
    if bytes.len() > MAX_ATTACHMENT_DOWNLOAD_BYTES {
        return Err("Attachment download exceeded the size limit".to_string());
    }

    let directory = attachment_download_dir()?;
    let file_name = safe_download_file_name(suggested_file_name.as_deref());
    let transferred_bytes = bytes.len();
    let saved_path = tokio::task::spawn_blocking(move || {
        persist_new_download(&directory, &file_name, bytes.as_ref())
    })
    .await
    .map_err(|_| "Attachment download writer failed".to_string())??;
    // Attachments are untrusted. Persist the bytes only; never hand the saved
    // path to an OS opener, which could execute active formats after one click.
    Ok(AttachmentDownloadResult {
        saved_path: saved_path.to_string_lossy().into_owned(),
        transferred_bytes,
        http_status: status.as_u16(),
    })
}

fn attachment_download_dir() -> Result<PathBuf, String> {
    if let Ok(configured) = std::env::var("THECHAT_ATTACHMENT_DOWNLOAD_DIR") {
        let configured = configured.trim();
        if configured.is_empty() {
            return Err("THECHAT_ATTACHMENT_DOWNLOAD_DIR must not be empty".to_string());
        }
        return Ok(PathBuf::from(configured));
    }
    dirs::download_dir().ok_or_else(|| "Failed to resolve the Downloads directory".to_string())
}

fn safe_download_file_name(value: Option<&str>) -> String {
    let leaf = value
        .unwrap_or("attachment")
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("attachment");
    let sanitized: String = leaf
        .chars()
        .map(|character| {
            if character.is_alphanumeric() || matches!(character, '.' | '-' | '_' | ' ') {
                character
            } else {
                '_'
            }
        })
        .collect();
    let sanitized = sanitized.trim_matches(|character| character == '.' || character == ' ');
    if sanitized.is_empty() {
        "attachment".to_string()
    } else {
        sanitized.to_string()
    }
}

fn persist_new_download(
    directory: &Path,
    file_name: &str,
    bytes: &[u8],
) -> Result<PathBuf, String> {
    fs::create_dir_all(directory)
        .map_err(|_| "Failed to create the Downloads directory".to_string())?;
    for sequence in 0..1_000 {
        let candidate = directory.join(unique_file_name(file_name, sequence));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        match options.open(&candidate) {
            Ok(mut file) => {
                if let Err(error) = file.write_all(bytes).and_then(|_| file.sync_all()) {
                    let _ = fs::remove_file(&candidate);
                    return Err(format!("Failed to save attachment: {error}"));
                }
                return Ok(candidate);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) => return Err("Failed to create attachment download".to_string()),
        }
    }
    Err("Failed to allocate a unique attachment file name".to_string())
}

fn unique_file_name(file_name: &str, sequence: usize) -> String {
    if sequence == 0 {
        return file_name.to_string();
    }
    let path = Path::new(file_name);
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("attachment");
    match path.extension().and_then(|value| value.to_str()) {
        Some(extension) if !extension.is_empty() => format!("{stem} ({sequence}).{extension}"),
        _ => format!("{stem} ({sequence})"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitizes_untrusted_file_names_to_one_leaf() {
        assert_eq!(
            safe_download_file_name(Some("../private/report?.txt")),
            "report_.txt"
        );
        assert_eq!(
            safe_download_file_name(Some("..\\private\\report.txt")),
            "report.txt"
        );
        assert_eq!(safe_download_file_name(Some("...")), "attachment");
    }

    #[test]
    fn never_overwrites_an_existing_download() {
        let directory = tempfile::tempdir().unwrap();
        let first = persist_new_download(directory.path(), "report.txt", b"first").unwrap();
        let second = persist_new_download(directory.path(), "report.txt", b"second").unwrap();
        assert_eq!(first.file_name().unwrap(), "report.txt");
        assert_eq!(second.file_name().unwrap(), "report (1).txt");
        assert_eq!(fs::read(first).unwrap(), b"first");
        assert_eq!(fs::read(second).unwrap(), b"second");
    }
}
