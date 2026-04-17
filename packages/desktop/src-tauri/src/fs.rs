use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::Manager;

// -- Result types --

#[derive(Debug, Serialize)]
pub struct ReadFileResult {
    pub content: String,
    pub total_lines: usize,
    pub lines_read: usize,
    pub truncated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_offset: Option<usize>,
}

#[derive(Debug, Serialize)]
pub struct WriteFileResult {
    pub success: bool,
    pub bytes_written: usize,
}

#[derive(Debug, Serialize)]
pub struct EditFileResult {
    pub success: bool,
    pub replacements: usize,
}

#[derive(Debug, Serialize)]
pub struct GlobResult {
    pub files: Vec<String>,
    pub count: usize,
    pub truncated: bool,
}

#[derive(Debug, Serialize)]
pub struct GrepMatch {
    pub file: String,
    pub line: usize,
    pub text: String,
}

#[derive(Debug, Serialize)]
pub struct GrepResult {
    pub matches: Vec<GrepMatch>,
    pub count: usize,
    pub truncated: bool,
}

#[derive(Debug, Serialize)]
pub struct ListDirResult {
    pub tree: String,
    pub count: usize,
    pub truncated: bool,
}

// -- Constants --

const MAX_LINE_LENGTH: usize = 2000;
const DEFAULT_LINE_LIMIT: usize = 2000;
const MAX_READ_BYTES: usize = 50 * 1024; // 50KB per Read call
const MAX_RESULTS: usize = 100;
const TRUNCATION_RETENTION_SECS: u64 = 7 * 24 * 3600; // 7 days

const DEFAULT_IGNORES: &[&str] = &[
    "node_modules",
    ".git",
    "dist",
    "build",
    "target",
    "__pycache__",
    ".next",
    ".nuxt",
    ".cache",
    ".turbo",
    "coverage",
    ".DS_Store",
];

const BINARY_EXTENSIONS: &[&str] = &[
    "exe", "dll", "so", "dylib", "a", "o", "obj", "lib", "jar", "class",
    "zip", "tar", "gz", "tgz", "bz2", "xz", "7z", "rar",
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "tiff",
    "mp3", "mp4", "avi", "mov", "mkv", "webm", "wav", "flac", "ogg", "m4a",
    "wasm", "pyc", "pyo", "bin", "dat", "db", "sqlite",
];

// -- Read helpers --

fn has_binary_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| BINARY_EXTENSIONS.iter().any(|b| e.eq_ignore_ascii_case(b)))
        .unwrap_or(false)
}

fn looks_binary(sample: &[u8]) -> bool {
    if sample.is_empty() {
        return false;
    }
    if sample.contains(&0) {
        return true;
    }
    let non_printable = sample
        .iter()
        .filter(|&&b| b < 9 || (b > 13 && b < 32) || b == 127)
        .count();
    (non_printable * 100 / sample.len()) > 30
}

fn levenshtein(a: &str, b: &str) -> usize {
    let av: Vec<char> = a.chars().collect();
    let bv: Vec<char> = b.chars().collect();
    let (m, n) = (av.len(), bv.len());
    if m == 0 {
        return n;
    }
    if n == 0 {
        return m;
    }
    let mut prev: Vec<usize> = (0..=n).collect();
    let mut curr = vec![0usize; n + 1];
    for i in 1..=m {
        curr[0] = i;
        for j in 1..=n {
            let cost = if av[i - 1] == bv[j - 1] { 0 } else { 1 };
            curr[j] = (prev[j] + 1).min(curr[j - 1] + 1).min(prev[j - 1] + cost);
        }
        std::mem::swap(&mut prev, &mut curr);
    }
    prev[n]
}

fn suggest_similar_files(missing: &Path) -> Vec<String> {
    let parent = match missing.parent() {
        Some(p) if !p.as_os_str().is_empty() => p,
        _ => Path::new("."),
    };
    let target = match missing.file_name().and_then(|n| n.to_str()) {
        Some(n) => n,
        None => return Vec::new(),
    };

    let entries: Vec<String> = match std::fs::read_dir(parent) {
        Ok(rd) => rd
            .filter_map(|e| e.ok())
            .filter_map(|e| e.file_name().into_string().ok())
            .collect(),
        Err(_) => return Vec::new(),
    };

    let mut scored: Vec<(String, usize)> = entries
        .into_iter()
        .map(|n| {
            let d = levenshtein(target, &n);
            (n, d)
        })
        .collect();
    // Only keep suggestions within a useful edit-distance window
    scored.sort_by_key(|(_, d)| *d);
    scored.truncate(3);
    let cutoff = (target.len() / 2).max(2);
    scored
        .into_iter()
        .filter(|(_, d)| *d <= cutoff)
        .map(|(n, _)| n)
        .collect()
}

#[derive(Debug, Serialize)]
pub struct ProjectInfo {
    pub is_git: bool,
    pub git_branch: Option<String>,
}

// -- Commands --

#[tauri::command]
#[tracing::instrument]
pub async fn get_project_info(path: String) -> Result<ProjectInfo, String> {
    tokio::task::spawn_blocking(move || {
        let base = Path::new(&path);
        if !base.exists() || !base.is_dir() {
            return Err(format!("Not a valid directory: {}", path));
        }

        let git_dir = base.join(".git");
        let is_git = git_dir.exists();

        let git_branch = if is_git {
            std::process::Command::new("git")
                .args(["rev-parse", "--abbrev-ref", "HEAD"])
                .current_dir(base)
                .output()
                .ok()
                .and_then(|out| {
                    if out.status.success() {
                        Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
                    } else {
                        None
                    }
                })
        } else {
            None
        };

        Ok(ProjectInfo { is_git, git_branch })
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
#[tracing::instrument]
pub async fn get_cwd() -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        std::env::current_dir()
            .map(|p| p.to_string_lossy().to_string())
            .map_err(|e| format!("Failed to get current directory: {}", e))
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
#[tracing::instrument]
pub async fn fs_read_file_raw(file_path: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let path = Path::new(&file_path);
        if !path.exists() {
            return Err(format!("File not found: {}", file_path));
        }
        if !path.is_file() {
            return Err(format!("Not a file: {}", file_path));
        }
        std::fs::read_to_string(path).map_err(|e| format!("Failed to read file: {}", e))
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
#[tracing::instrument]
pub async fn fs_read_file(
    file_path: String,
    offset: Option<usize>,
    limit: Option<usize>,
    line_numbers: Option<bool>,
) -> Result<ReadFileResult, String> {
    tokio::task::spawn_blocking(move || {
        let path = Path::new(&file_path);
        if !path.exists() {
            let suggestions = suggest_similar_files(path);
            let msg = if suggestions.is_empty() {
                format!("File not found: {}", file_path)
            } else {
                format!(
                    "File not found: {}. Did you mean: {}?",
                    file_path,
                    suggestions.join(", ")
                )
            };
            return Err(msg);
        }
        if !path.is_file() {
            return Err(format!("Not a file: {}", file_path));
        }

        if has_binary_extension(path) {
            return Err(format!(
                "File appears to be binary (by extension): {}. This tool only reads text files.",
                file_path
            ));
        }

        // Sample first 4KB to sniff for binary content
        {
            use std::io::Read;
            let mut buf = [0u8; 4096];
            let mut f = std::fs::File::open(path)
                .map_err(|e| format!("Failed to open file: {}", e))?;
            let n = f
                .read(&mut buf)
                .map_err(|e| format!("Failed to read file: {}", e))?;
            if looks_binary(&buf[..n]) {
                return Err(format!(
                    "File appears to be binary (contains non-text bytes): {}. This tool only reads text files.",
                    file_path
                ));
            }
        }

        let content =
            std::fs::read_to_string(path).map_err(|e| format!("Failed to read file: {}", e))?;

        let all_lines: Vec<&str> = content.lines().collect();
        let total_lines = all_lines.len();
        // Offset is 1-indexed: offset=1 means start at the first line.
        // Accept 0 as an alias for 1 for backwards compatibility.
        let start_one = offset.unwrap_or(1).max(1);
        let start = start_one - 1;
        let max_lines = limit.unwrap_or(DEFAULT_LINE_LIMIT);

        if start >= total_lines {
            return Ok(ReadFileResult {
                content: String::new(),
                total_lines,
                lines_read: 0,
                truncated: false,
                next_offset: None,
            });
        }

        let end_by_line = (start + max_lines).min(total_lines);
        let show_line_numbers = line_numbers.unwrap_or(false);

        let mut result = String::new();
        let mut emitted_lines = 0usize;
        let mut byte_cap_hit = false;
        let mut last_idx = start;

        for (i, line) in all_lines[start..end_by_line].iter().enumerate() {
            let line_num = start + i + 1;
            let truncated_line_suffix =
                format!("... (line truncated to {} chars)", MAX_LINE_LENGTH);
            let display = if line.len() > MAX_LINE_LENGTH {
                format!("{}{}", &line[..MAX_LINE_LENGTH], truncated_line_suffix)
            } else {
                line.to_string()
            };
            let segment = if show_line_numbers {
                format!("{:>6}\t{}\n", line_num, display)
            } else {
                format!("{}\n", display)
            };
            if emitted_lines > 0 && result.len() + segment.len() > MAX_READ_BYTES {
                byte_cap_hit = true;
                break;
            }
            result.push_str(&segment);
            emitted_lines += 1;
            last_idx = start + i;
        }

        let truncated = byte_cap_hit || end_by_line < total_lines;
        let next_offset = if byte_cap_hit {
            Some(last_idx + 2) // next line, 1-indexed
        } else if end_by_line < total_lines {
            Some(end_by_line + 1)
        } else {
            None
        };

        Ok(ReadFileResult {
            content: result,
            total_lines,
            lines_read: emitted_lines,
            truncated,
            next_offset,
        })
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
#[tracing::instrument(skip(content))]
pub async fn fs_write_file(file_path: String, content: String) -> Result<WriteFileResult, String> {
    tokio::task::spawn_blocking(move || {
        let path = Path::new(&file_path);

        // Create parent directories if they don't exist
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create directories: {}", e))?;
        }

        let bytes_written = content.len();
        std::fs::write(path, &content).map_err(|e| format!("Failed to write file: {}", e))?;

        Ok(WriteFileResult {
            success: true,
            bytes_written,
        })
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
#[tracing::instrument(skip(old_string, new_string))]
pub async fn fs_edit_file(
    file_path: String,
    old_string: String,
    new_string: String,
    replace_all: Option<bool>,
) -> Result<EditFileResult, String> {
    tokio::task::spawn_blocking(move || {
        let path = Path::new(&file_path);
        if !path.exists() {
            return Err(format!("File not found: {}", file_path));
        }

        let content =
            std::fs::read_to_string(path).map_err(|e| format!("Failed to read file: {}", e))?;

        let replace_all = replace_all.unwrap_or(false);

        // Count occurrences
        let count = content.matches(&old_string).count();

        if count == 0 {
            // Try CRLF-normalized matching as fallback (Windows line endings)
            let normalized_content = content.replace("\r\n", "\n");
            let normalized_old = old_string.replace("\r\n", "\n");
            let normalized_count = normalized_content.matches(&normalized_old).count();

            if normalized_count > 0 {
                if normalized_count > 1 && !replace_all {
                    return Err(format!(
                        "Found {} occurrences of the string (after line-ending normalization). \
                         Use replace_all: true to replace all, \
                         or provide more surrounding context to make the match unique.",
                        normalized_count
                    ));
                }

                let new_content = if replace_all {
                    normalized_content.replace(&normalized_old, &new_string)
                } else {
                    normalized_content.replacen(&normalized_old, &new_string, 1)
                };

                // Restore CRLF if the original file used it
                let final_content = if content.contains("\r\n") {
                    new_content.replace('\n', "\r\n")
                } else {
                    new_content
                };

                std::fs::write(path, &final_content)
                    .map_err(|e| format!("Failed to write file: {}", e))?;

                let replacements = if replace_all { normalized_count } else { 1 };
                return Ok(EditFileResult {
                    success: true,
                    replacements,
                });
            }

            // Try line-trimmed matching as fallback
            let trimmed_old = old_string
                .lines()
                .map(|l| l.trim())
                .collect::<Vec<_>>()
                .join("\n");
            let trimmed_content = content
                .lines()
                .map(|l| l.trim())
                .collect::<Vec<_>>()
                .join("\n");

            if trimmed_content.contains(&trimmed_old) {
                return Err(format!(
                    "Exact string not found, but a similar match exists with different indentation. \
                     Please provide the exact string including whitespace."
                ));
            }

            return Err(format!(
                "String not found in file. Make sure the old_string matches exactly."
            ));
        }

        if count > 1 && !replace_all {
            return Err(format!(
                "Found {} occurrences of the string. Use replace_all: true to replace all, \
                 or provide more surrounding context to make the match unique.",
                count
            ));
        }

        let new_content = if replace_all {
            content.replace(&old_string, &new_string)
        } else {
            content.replacen(&old_string, &new_string, 1)
        };

        std::fs::write(path, &new_content).map_err(|e| format!("Failed to write file: {}", e))?;

        let replacements = if replace_all { count } else { 1 };
        Ok(EditFileResult {
            success: true,
            replacements,
        })
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
#[tracing::instrument]
pub async fn fs_glob(
    pattern: String,
    path: Option<String>,
    limit: Option<usize>,
) -> Result<GlobResult, String> {
    tokio::task::spawn_blocking(move || {
        let max = limit.unwrap_or(MAX_RESULTS);

        // Resolve the pattern relative to the base path
        let full_pattern = if let Some(ref base) = path {
            let base_path = PathBuf::from(base);
            if Path::new(&pattern).is_absolute() {
                pattern.clone()
            } else {
                base_path.join(&pattern).to_string_lossy().to_string()
            }
        } else {
            pattern.clone()
        };

        let entries: Vec<PathBuf> = glob::glob(&full_pattern)
            .map_err(|e| format!("Invalid glob pattern: {}", e))?
            .filter_map(|entry| entry.ok())
            .filter(|p| p.is_file())
            .collect();

        // Sort by modification time (most recent first)
        let mut entries_with_mtime: Vec<(PathBuf, std::time::SystemTime)> = entries
            .into_iter()
            .filter_map(|p| {
                p.metadata()
                    .ok()
                    .and_then(|m| m.modified().ok())
                    .map(|t| (p, t))
            })
            .collect();

        entries_with_mtime.sort_by(|a, b| b.1.cmp(&a.1));

        let truncated = entries_with_mtime.len() > max;
        let files: Vec<String> = entries_with_mtime
            .into_iter()
            .take(max)
            .map(|(p, _)| p.to_string_lossy().to_string())
            .collect();

        let count = files.len();

        Ok(GlobResult {
            files,
            count,
            truncated,
        })
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// Translate a user-supplied include filter ("*.ts", ".rs", "rs", "**/foo.md")
/// into a `globset::Glob` we can match against file paths.
fn build_include_glob(include: &str) -> Result<globset::GlobMatcher, String> {
    let t = include.trim();
    let pat = if t.contains('*') || t.contains('/') {
        t.to_string()
    } else if let Some(rest) = t.strip_prefix('.') {
        format!("*.{}", rest)
    } else {
        format!("*.{}", t)
    };
    globset::Glob::new(&pat)
        .map(|g| g.compile_matcher())
        .map_err(|e| format!("Invalid include pattern: {}", e))
}

/// Sink that collects matches into a shared Vec, honoring a hard cap.
struct CollectSink<'a> {
    matches: &'a mut Vec<GrepMatch>,
    file: &'a str,
    limit: usize,
}

impl<'a> grep_searcher::Sink for CollectSink<'a> {
    type Error = std::io::Error;

    fn matched(
        &mut self,
        _searcher: &grep_searcher::Searcher,
        sink_match: &grep_searcher::SinkMatch<'_>,
    ) -> Result<bool, Self::Error> {
        if self.matches.len() >= self.limit {
            return Ok(false);
        }
        let line = std::str::from_utf8(sink_match.bytes())
            .unwrap_or("")
            .trim_end_matches('\n')
            .trim_end_matches('\r')
            .to_string();
        let display = if line.len() > MAX_LINE_LENGTH {
            format!("{}...", &line[..MAX_LINE_LENGTH])
        } else {
            line
        };
        let line_num = sink_match.line_number().unwrap_or(0) as usize;
        self.matches.push(GrepMatch {
            file: self.file.to_string(),
            line: line_num,
            text: display,
        });
        Ok(true)
    }
}

#[tauri::command]
#[tracing::instrument]
pub async fn fs_grep(
    pattern: String,
    path: Option<String>,
    include: Option<String>,
    limit: Option<usize>,
) -> Result<GrepResult, String> {
    tokio::task::spawn_blocking(move || {
        let max = limit.unwrap_or(MAX_RESULTS);
        let base = path.unwrap_or_else(|| ".".to_string());
        let base_path = Path::new(&base);

        let matcher = grep_regex::RegexMatcher::new(&pattern)
            .map_err(|e| format!("Invalid regex pattern: {}", e))?;

        let include_glob = match include.as_deref() {
            Some(s) => Some(build_include_glob(s)?),
            None => None,
        };

        // `ignore::WalkBuilder` respects .gitignore/.ignore/global excludes
        // by default. `hidden(false)` mirrors `rg --hidden` so files like
        // `.env.example` are still searchable. `.git/` is still skipped via
        // the explicit path-component check below (belt-and-suspenders).
        let walker = ignore::WalkBuilder::new(base_path)
            .hidden(false)
            .git_ignore(true)
            .git_exclude(true)
            .git_global(true)
            .follow_links(false)
            .build();

        let mut searcher = grep_searcher::SearcherBuilder::new()
            .line_number(true)
            .binary_detection(grep_searcher::BinaryDetection::quit(0))
            .build();

        let mut matches: Vec<GrepMatch> = Vec::new();
        let mut truncated = false;

        for entry in walker {
            if matches.len() >= max {
                truncated = true;
                break;
            }
            let entry = match entry {
                Ok(e) => e,
                Err(_) => continue,
            };
            if !entry.file_type().map(|ft| ft.is_file()).unwrap_or(false) {
                continue;
            }
            let path = entry.path();
            if path
                .components()
                .any(|c| c.as_os_str() == std::ffi::OsStr::new(".git"))
            {
                continue;
            }
            if let Some(ref g) = include_glob {
                let name_matches = path
                    .file_name()
                    .map(|n| g.is_match(n))
                    .unwrap_or(false);
                if !name_matches && !g.is_match(path) {
                    continue;
                }
            }

            let file_str = path.to_string_lossy().to_string();
            let _ = searcher.search_path(
                &matcher,
                path,
                CollectSink {
                    matches: &mut matches,
                    file: &file_str,
                    limit: max,
                },
            );
        }

        // Sort by file mtime (newest first), preserving line order within a file.
        let mut mtimes: std::collections::HashMap<String, std::time::SystemTime> =
            std::collections::HashMap::new();
        for m in &matches {
            if !mtimes.contains_key(&m.file) {
                if let Ok(meta) = std::fs::metadata(&m.file) {
                    if let Ok(t) = meta.modified() {
                        mtimes.insert(m.file.clone(), t);
                    }
                }
            }
        }
        matches.sort_by(|a, b| {
            let ma = mtimes
                .get(&a.file)
                .copied()
                .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
            let mb = mtimes
                .get(&b.file)
                .copied()
                .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
            match mb.cmp(&ma) {
                std::cmp::Ordering::Equal => {
                    a.file.cmp(&b.file).then(a.line.cmp(&b.line))
                }
                other => other,
            }
        });

        if matches.len() > max {
            truncated = true;
            matches.truncate(max);
        }

        let count = matches.len();
        Ok(GrepResult {
            matches,
            count,
            truncated,
        })
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
#[tracing::instrument]
pub async fn fs_list_dir(
    path: Option<String>,
    ignore: Option<Vec<String>>,
    limit: Option<usize>,
) -> Result<ListDirResult, String> {
    tokio::task::spawn_blocking(move || {
        let max = limit.unwrap_or(MAX_RESULTS);
        let base = path.unwrap_or_else(|| ".".to_string());
        let base_path = Path::new(&base);

        if !base_path.exists() {
            return Err(format!("Directory not found: {}", base));
        }
        if !base_path.is_dir() {
            return Err(format!("Not a directory: {}", base));
        }

        let custom_ignores: Vec<String> = ignore.unwrap_or_default();
        let ignore_set: Vec<&str> = DEFAULT_IGNORES
            .iter()
            .copied()
            .chain(custom_ignores.iter().map(|s| s.as_str()))
            .collect();

        let mut entries: Vec<String> = Vec::new();
        let mut count = 0;
        let mut truncated = false;

        let walker = walkdir::WalkDir::new(base_path)
            .follow_links(false)
            .sort_by_file_name()
            .into_iter()
            .filter_entry(|e| {
                let name = e.file_name().to_string_lossy();
                !ignore_set.iter().any(|ign| name == *ign)
            });

        for entry in walker {
            let entry = match entry {
                Ok(e) => e,
                Err(_) => continue,
            };

            // Skip the root itself
            if entry.path() == base_path {
                continue;
            }

            count += 1;
            if count > max {
                truncated = true;
                break;
            }

            let depth = entry.depth();
            let indent = "  ".repeat(depth.saturating_sub(1));
            let name = entry.file_name().to_string_lossy();

            if entry.file_type().is_dir() {
                entries.push(format!("{}{}/", indent, name));
            } else {
                entries.push(format!("{}{}", indent, name));
            }
        }

        let tree = entries.join("\n");

        Ok(ListDirResult {
            tree,
            count: count.min(max),
            truncated,
        })
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// Determine file extension from MIME type.
fn ext_for_mime(mime: &str) -> &str {
    match mime {
        "image/png" => "png",
        "image/jpeg" | "image/jpg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/svg+xml" => "svg",
        "image/bmp" => "bmp",
        _ => "bin",
    }
}

#[tauri::command]
#[tracing::instrument(skip(base64_data))]
pub async fn save_image(
    app: tauri::AppHandle,
    conversation_id: String,
    image_id: String,
    mime_type: String,
    base64_data: String,
) -> Result<String, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {}", e))?;

    tokio::task::spawn_blocking(move || -> Result<String, String> {
        let ext = ext_for_mime(&mime_type);
        let images_dir = data_dir.join("images").join(&conversation_id);
        std::fs::create_dir_all(&images_dir)
            .map_err(|e| format!("Failed to create images dir: {}", e))?;

        let file_name = format!("{}.{}", image_id, ext);
        let file_path = images_dir.join(&file_name);

        let bytes = BASE64
            .decode(&base64_data)
            .map_err(|e| format!("Invalid base64 data: {}", e))?;

        std::fs::write(&file_path, &bytes)
            .map_err(|e| format!("Failed to write image: {}", e))?;

        Ok(file_path.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
#[tracing::instrument]
pub async fn load_image_base64(file_path: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let path = Path::new(&file_path);
        if !path.exists() {
            return Err(format!("Image not found: {}", file_path));
        }
        let bytes =
            std::fs::read(path).map_err(|e| format!("Failed to read image: {}", e))?;
        Ok(BASE64.encode(&bytes))
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// Persist a truncated tool-call output to the app data dir so the model can
/// re-fetch the full content by path. Returns the absolute path of the
/// written file. Runs a cheap retention sweep (delete entries older than 7d).
#[tauri::command]
#[tracing::instrument(skip(content))]
pub async fn fs_truncation_write(
    app: tauri::AppHandle,
    content: String,
) -> Result<String, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {}", e))?;

    tokio::task::spawn_blocking(move || -> Result<String, String> {
        let dir = data_dir.join("truncation");
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("Failed to create truncation dir: {}", e))?;

        // Retention sweep: remove truncation files older than 7 days
        let cutoff = std::time::SystemTime::now()
            .checked_sub(std::time::Duration::from_secs(TRUNCATION_RETENTION_SECS));
        if let (Some(cutoff), Ok(rd)) = (cutoff, std::fs::read_dir(&dir)) {
            for entry in rd.flatten() {
                if let Ok(meta) = entry.metadata() {
                    if let Ok(modified) = meta.modified() {
                        if modified < cutoff {
                            let _ = std::fs::remove_file(entry.path());
                        }
                    }
                }
            }
        }

        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let id = uuid::Uuid::new_v4().simple().to_string();
        let filename = format!("tool_{:013}_{}.txt", now_ms, &id[..8]);
        let full = dir.join(&filename);
        std::fs::write(&full, &content)
            .map_err(|e| format!("Failed to write truncation file: {}", e))?;
        Ok(full.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// Attempt to format a file in place using the tool conventional for its
/// extension. Silent no-op if the formatter binary is not installed or
/// execution fails — so callers can always invoke this without risking a
/// successful write being marked as a failure.
#[tauri::command]
#[tracing::instrument]
pub async fn fs_format_file(file_path: String) -> Result<bool, String> {
    tokio::task::spawn_blocking(move || {
        let path = Path::new(&file_path);
        if !path.exists() || !path.is_file() {
            return Ok(false);
        }
        let ext = match path.extension().and_then(|e| e.to_str()) {
            Some(e) => e.to_lowercase(),
            None => return Ok(false),
        };

        let file_arg = file_path.clone();
        let (prog, args): (&str, Vec<String>) = match ext.as_str() {
            "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" | "json" | "jsonc"
            | "css" | "scss" | "less" | "html" | "htm" | "md" | "mdx"
            | "yaml" | "yml" => {
                // Prefer project-local prettier if present, else fall back to PATH.
                let local = find_local_bin(path, "prettier");
                let bin: &str = local.as_deref().unwrap_or("prettier");
                return Ok(run_formatter(bin, &["--write".to_string(), file_arg]));
            }
            "rs" => ("rustfmt", vec![file_arg]),
            "go" => ("gofmt", vec!["-w".to_string(), file_arg]),
            "py" => ("ruff", vec!["format".to_string(), file_arg]),
            _ => return Ok(false),
        };
        Ok(run_formatter(prog, &args))
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

fn run_formatter(prog: &str, args: &[String]) -> bool {
    let mut cmd = std::process::Command::new(prog);
    cmd.args(args);
    // Suppress stdout/stderr — formatters are noisy and we swallow failures.
    cmd.stdout(std::process::Stdio::null());
    cmd.stderr(std::process::Stdio::null());
    matches!(cmd.status(), Ok(s) if s.success())
}

/// Walk up from `start`'s directory looking for node_modules/.bin/<name>.
fn find_local_bin(start: &Path, name: &str) -> Option<String> {
    let mut cur: PathBuf = start
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."));
    loop {
        let candidate = cur.join("node_modules").join(".bin").join(name);
        if candidate.exists() {
            return Some(candidate.to_string_lossy().into_owned());
        }
        if !cur.pop() {
            break;
        }
    }
    None
}

#[tauri::command]
#[tracing::instrument]
pub async fn fs_delete_file(file_path: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let path = Path::new(&file_path);
        if !path.exists() {
            return Err(format!("File not found: {}", file_path));
        }
        if !path.is_file() {
            return Err(format!("Not a file: {}", file_path));
        }
        std::fs::remove_file(path).map_err(|e| format!("Failed to delete file: {}", e))
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_dir() -> tempfile::TempDir {
        tempfile::TempDir::new().unwrap()
    }

    #[tokio::test]
    async fn read_file_basic() {
        let dir = temp_dir();
        let file = dir.path().join("test.txt");
        fs::write(&file, "line1\nline2\nline3\n").unwrap();

        let result = fs_read_file(file.to_string_lossy().to_string(), None, None, None)
            .await
            .unwrap();
        assert_eq!(result.total_lines, 3);
        assert_eq!(result.lines_read, 3);
        assert!(!result.truncated);
        assert!(result.content.contains("line1"));
        assert!(result.content.contains("line2"));
        // Default: no line numbers
        assert!(!result.content.contains("\t"));

        // With line numbers
        let result_ln = fs_read_file(file.to_string_lossy().to_string(), None, None, Some(true))
            .await
            .unwrap();
        assert!(result_ln.content.contains("     1\tline1"));
    }

    #[tokio::test]
    async fn read_file_with_offset_and_limit() {
        let dir = temp_dir();
        let file = dir.path().join("test.txt");
        fs::write(&file, "a\nb\nc\nd\ne\n").unwrap();

        // offset=2 → start at line 2 (1-indexed), limit=2 → read b and c
        let result = fs_read_file(file.to_string_lossy().to_string(), Some(2), Some(2), None)
            .await
            .unwrap();
        assert_eq!(result.lines_read, 2);
        assert!(result.truncated);
        assert!(result.content.contains("b"));
        assert!(result.content.contains("c"));
        assert!(!result.content.contains("a"));
        assert_eq!(result.next_offset, Some(4));
    }

    #[tokio::test]
    async fn read_file_offset_one_returns_from_first_line() {
        let dir = temp_dir();
        let file = dir.path().join("test.txt");
        fs::write(&file, "a\nb\nc\n").unwrap();

        let result = fs_read_file(file.to_string_lossy().to_string(), Some(1), None, None)
            .await
            .unwrap();
        assert_eq!(result.lines_read, 3);
        assert!(result.content.contains("a"));
        assert!(result.content.contains("c"));
        assert!(!result.truncated);
    }

    #[tokio::test]
    async fn read_file_rejects_binary_by_extension() {
        let dir = temp_dir();
        let file = dir.path().join("blob.png");
        fs::write(&file, b"not actually a png").unwrap();

        let err = fs_read_file(file.to_string_lossy().to_string(), None, None, None)
            .await
            .unwrap_err();
        assert!(err.contains("binary"));
    }

    #[tokio::test]
    async fn read_file_rejects_binary_by_content() {
        let dir = temp_dir();
        let file = dir.path().join("data.txt");
        let mut bytes = b"hello world".to_vec();
        bytes.push(0); // NUL byte → looks binary
        fs::write(&file, bytes).unwrap();

        let err = fs_read_file(file.to_string_lossy().to_string(), None, None, None)
            .await
            .unwrap_err();
        assert!(err.contains("binary"));
    }

    #[tokio::test]
    async fn read_file_suggests_similar_filenames() {
        let dir = temp_dir();
        fs::write(dir.path().join("config.json"), "{}").unwrap();
        fs::write(dir.path().join("package.json"), "{}").unwrap();
        let missing = dir.path().join("cofnig.json");

        let err = fs_read_file(missing.to_string_lossy().to_string(), None, None, None)
            .await
            .unwrap_err();
        assert!(err.contains("config.json"), "got: {}", err);
    }

    #[tokio::test]
    async fn read_file_byte_cap_enforced_with_next_offset() {
        let dir = temp_dir();
        let file = dir.path().join("big.txt");
        // 100 lines of ~1KB each → ~100KB total, will trip the 50KB cap
        let mut content = String::new();
        for i in 0..100 {
            content.push_str(&format!("{:04}-{}\n", i, "x".repeat(1000)));
        }
        fs::write(&file, &content).unwrap();

        let result = fs_read_file(file.to_string_lossy().to_string(), None, None, None)
            .await
            .unwrap();
        assert!(result.truncated);
        assert!(result.lines_read < 100);
        assert!(result.next_offset.is_some());
        // The emitted content should be within the byte cap plus one buffered line
        assert!(result.content.len() <= MAX_READ_BYTES + 2_000);
    }

    #[tokio::test]
    async fn read_file_not_found() {
        let result = fs_read_file("/nonexistent/file.txt".into(), None, None, None).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn write_file_creates_and_writes() {
        let dir = temp_dir();
        let file = dir.path().join("output.txt");

        let result = fs_write_file(file.to_string_lossy().to_string(), "hello world".into())
            .await
            .unwrap();
        assert!(result.success);
        assert_eq!(result.bytes_written, 11);
        assert_eq!(fs::read_to_string(&file).unwrap(), "hello world");
    }

    #[tokio::test]
    async fn write_file_creates_parent_dirs() {
        let dir = temp_dir();
        let file = dir.path().join("a/b/c/output.txt");

        let result = fs_write_file(file.to_string_lossy().to_string(), "nested".into())
            .await
            .unwrap();
        assert!(result.success);
        assert_eq!(fs::read_to_string(&file).unwrap(), "nested");
    }

    #[tokio::test]
    async fn edit_file_single_replacement() {
        let dir = temp_dir();
        let file = dir.path().join("test.txt");
        fs::write(&file, "hello world").unwrap();

        let result = fs_edit_file(
            file.to_string_lossy().to_string(),
            "hello".into(),
            "goodbye".into(),
            None,
        )
        .await
        .unwrap();

        assert!(result.success);
        assert_eq!(result.replacements, 1);
        assert_eq!(fs::read_to_string(&file).unwrap(), "goodbye world");
    }

    #[tokio::test]
    async fn edit_file_errors_on_multiple_matches_without_replace_all() {
        let dir = temp_dir();
        let file = dir.path().join("test.txt");
        fs::write(&file, "foo bar foo baz foo").unwrap();

        let result = fs_edit_file(
            file.to_string_lossy().to_string(),
            "foo".into(),
            "qux".into(),
            None,
        )
        .await;

        assert!(result.is_err());
        assert!(result.unwrap_err().contains("3 occurrences"));
    }

    #[tokio::test]
    async fn edit_file_replace_all() {
        let dir = temp_dir();
        let file = dir.path().join("test.txt");
        fs::write(&file, "foo bar foo baz foo").unwrap();

        let result = fs_edit_file(
            file.to_string_lossy().to_string(),
            "foo".into(),
            "qux".into(),
            Some(true),
        )
        .await
        .unwrap();

        assert_eq!(result.replacements, 3);
        assert_eq!(fs::read_to_string(&file).unwrap(), "qux bar qux baz qux");
    }

    #[tokio::test]
    async fn edit_file_not_found_error() {
        let result = fs_edit_file(
            "/nonexistent/file.txt".into(),
            "old".into(),
            "new".into(),
            None,
        )
        .await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn edit_file_string_not_found() {
        let dir = temp_dir();
        let file = dir.path().join("test.txt");
        fs::write(&file, "hello world").unwrap();

        let result = fs_edit_file(
            file.to_string_lossy().to_string(),
            "nonexistent".into(),
            "new".into(),
            None,
        )
        .await;

        assert!(result.is_err());
        assert!(result.unwrap_err().contains("not found"));
    }

    #[tokio::test]
    async fn glob_finds_files() {
        let dir = temp_dir();
        fs::write(dir.path().join("a.txt"), "a").unwrap();
        fs::write(dir.path().join("b.txt"), "b").unwrap();
        fs::write(dir.path().join("c.rs"), "c").unwrap();

        let pattern = format!("{}/*.txt", dir.path().display());
        let result = fs_glob(pattern, None, None).await.unwrap();
        assert_eq!(result.count, 2);
        assert!(!result.truncated);
    }

    #[tokio::test]
    async fn glob_respects_limit() {
        let dir = temp_dir();
        for i in 0..10 {
            fs::write(dir.path().join(format!("{}.txt", i)), "x").unwrap();
        }

        let pattern = format!("{}/*.txt", dir.path().display());
        let result = fs_glob(pattern, None, Some(3)).await.unwrap();
        assert_eq!(result.count, 3);
        assert!(result.truncated);
    }

    #[tokio::test]
    async fn grep_finds_matches() {
        let dir = temp_dir();
        fs::write(
            dir.path().join("test.txt"),
            "hello world\nfoo bar\nhello again\n",
        )
        .unwrap();

        let result = fs_grep(
            "hello".into(),
            Some(dir.path().to_string_lossy().to_string()),
            None,
            None,
        )
        .await
        .unwrap();

        assert_eq!(result.count, 2);
        assert_eq!(result.matches[0].line, 1);
        assert_eq!(result.matches[1].line, 3);
    }

    #[tokio::test]
    async fn grep_respects_gitignore() {
        let dir = temp_dir();
        // Pretend this is a git repo by writing a .gitignore
        fs::write(dir.path().join(".gitignore"), "ignored/\n").unwrap();
        // The ignore crate only activates .gitignore inside a real git repo,
        // so also create a .git marker directory.
        fs::create_dir(dir.path().join(".git")).unwrap();
        fs::create_dir(dir.path().join("ignored")).unwrap();
        fs::write(dir.path().join("ignored/hit.txt"), "needle").unwrap();
        fs::write(dir.path().join("visible.txt"), "needle").unwrap();

        let result = fs_grep(
            "needle".into(),
            Some(dir.path().to_string_lossy().to_string()),
            None,
            None,
        )
        .await
        .unwrap();

        // Only the non-ignored file should be found. `.git/` is skipped, and
        // `ignored/` is excluded by the gitignore.
        assert_eq!(result.count, 1);
        assert!(result.matches[0].file.ends_with("visible.txt"));
    }

    #[tokio::test]
    async fn grep_with_include_filter() {
        let dir = temp_dir();
        fs::write(dir.path().join("test.txt"), "hello").unwrap();
        fs::write(dir.path().join("test.rs"), "hello").unwrap();

        let result = fs_grep(
            "hello".into(),
            Some(dir.path().to_string_lossy().to_string()),
            Some("*.txt".into()),
            None,
        )
        .await
        .unwrap();

        assert_eq!(result.count, 1);
        assert!(result.matches[0].file.ends_with(".txt"));
    }

    #[tokio::test]
    async fn list_dir_basic() {
        let dir = temp_dir();
        fs::write(dir.path().join("file1.txt"), "a").unwrap();
        fs::create_dir(dir.path().join("subdir")).unwrap();
        fs::write(dir.path().join("subdir/file2.txt"), "b").unwrap();

        let result = fs_list_dir(Some(dir.path().to_string_lossy().to_string()), None, None)
            .await
            .unwrap();

        assert!(result.count >= 2);
        assert!(result.tree.contains("file1.txt"));
        assert!(result.tree.contains("subdir/"));
    }

    #[tokio::test]
    async fn list_dir_ignores_defaults() {
        let dir = temp_dir();
        fs::create_dir(dir.path().join("node_modules")).unwrap();
        fs::write(dir.path().join("node_modules/pkg.js"), "x").unwrap();
        fs::write(dir.path().join("app.js"), "y").unwrap();

        let result = fs_list_dir(Some(dir.path().to_string_lossy().to_string()), None, None)
            .await
            .unwrap();

        assert!(result.tree.contains("app.js"));
        assert!(!result.tree.contains("node_modules"));
    }

    #[tokio::test]
    async fn list_dir_respects_limit() {
        let dir = temp_dir();
        for i in 0..20 {
            fs::write(dir.path().join(format!("file{}.txt", i)), "x").unwrap();
        }

        let result = fs_list_dir(
            Some(dir.path().to_string_lossy().to_string()),
            None,
            Some(5),
        )
        .await
        .unwrap();

        assert_eq!(result.count, 5);
        assert!(result.truncated);
    }
}
