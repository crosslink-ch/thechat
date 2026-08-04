use std::path::Path;
use tauri::ipc::Response;

const MAX_DROPPED_FILE_BYTES: u64 = 25 * 1024 * 1024;

fn read_dropped_file_bytes(path: &Path) -> Result<Vec<u8>, String> {
    let metadata = std::fs::metadata(path)
        .map_err(|error| format!("Failed to inspect dropped file: {error}"))?;
    if !metadata.is_file() {
        return Err("Dropped path is not a file".to_string());
    }
    if metadata.len() > MAX_DROPPED_FILE_BYTES {
        return Err("Dropped file is larger than 25 MiB".to_string());
    }

    let bytes =
        std::fs::read(path).map_err(|error| format!("Failed to read dropped file: {error}"))?;
    if bytes.len() as u64 > MAX_DROPPED_FILE_BYTES {
        return Err("Dropped file is larger than 25 MiB".to_string());
    }
    Ok(bytes)
}

#[tauri::command]
#[tracing::instrument(skip_all)]
pub async fn read_dropped_file(file_path: String) -> Result<Response, String> {
    let bytes = tokio::task::spawn_blocking(move || read_dropped_file_bytes(Path::new(&file_path)))
        .await
        .map_err(|error| format!("Dropped file task failed: {error}"))??;
    Ok(Response::new(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_binary_file_bytes() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("image.png");
        std::fs::write(&path, [0, 1, 2, 255]).unwrap();

        assert_eq!(read_dropped_file_bytes(&path).unwrap(), [0, 1, 2, 255]);
    }

    #[test]
    fn rejects_directories() {
        let dir = tempfile::TempDir::new().unwrap();

        let error = read_dropped_file_bytes(dir.path()).unwrap_err();

        assert_eq!(error, "Dropped path is not a file");
    }

    #[test]
    fn rejects_files_over_attachment_limit_before_reading() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("too-large.bin");
        let file = std::fs::File::create(&path).unwrap();
        file.set_len(MAX_DROPPED_FILE_BYTES + 1).unwrap();

        let error = read_dropped_file_bytes(&path).unwrap_err();

        assert_eq!(error, "Dropped file is larger than 25 MiB");
    }
}
