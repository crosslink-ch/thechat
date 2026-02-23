use serde::Serialize;
use std::path::{Path, PathBuf};

// -- Result types --

#[derive(Debug, Serialize)]
pub struct ReadFileResult {
    pub content: String,
    pub total_lines: usize,
    pub lines_read: usize,
    pub truncated: bool,
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
const MAX_RESULTS: usize = 100;

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

#[derive(Debug, Serialize)]
pub struct ProjectInfo {
    pub is_git: bool,
    pub git_branch: Option<String>,
}

// -- Commands --

#[tauri::command]
pub fn get_project_info(path: String) -> Result<ProjectInfo, String> {
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

    Ok(ProjectInfo {
        is_git,
        git_branch,
    })
}

#[tauri::command]
pub fn get_cwd() -> Result<String, String> {
    std::env::current_dir()
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|e| format!("Failed to get current directory: {}", e))
}

#[tauri::command]
pub fn fs_read_file(
    file_path: String,
    offset: Option<usize>,
    limit: Option<usize>,
    line_numbers: Option<bool>,
) -> Result<ReadFileResult, String> {
    let path = Path::new(&file_path);
    if !path.exists() {
        return Err(format!("File not found: {}", file_path));
    }
    if !path.is_file() {
        return Err(format!("Not a file: {}", file_path));
    }

    let content =
        std::fs::read_to_string(path).map_err(|e| format!("Failed to read file: {}", e))?;

    let all_lines: Vec<&str> = content.lines().collect();
    let total_lines = all_lines.len();
    let start = offset.unwrap_or(0);
    let max_lines = limit.unwrap_or(DEFAULT_LINE_LIMIT);

    if start >= total_lines {
        return Ok(ReadFileResult {
            content: String::new(),
            total_lines,
            lines_read: 0,
            truncated: false,
        });
    }

    let end = (start + max_lines).min(total_lines);
    let truncated = end < total_lines;

    let show_line_numbers = line_numbers.unwrap_or(false);
    let mut result = String::new();
    for (i, line) in all_lines[start..end].iter().enumerate() {
        let line_num = start + i + 1; // 1-based
        let display_line = if line.len() > MAX_LINE_LENGTH {
            &line[..MAX_LINE_LENGTH]
        } else {
            line
        };
        if show_line_numbers {
            result.push_str(&format!("{:>6}\t{}\n", line_num, display_line));
        } else {
            result.push_str(display_line);
            result.push('\n');
        }
    }

    Ok(ReadFileResult {
        content: result,
        total_lines,
        lines_read: end - start,
        truncated,
    })
}

#[tauri::command]
pub fn fs_write_file(file_path: String, content: String) -> Result<WriteFileResult, String> {
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
}

#[tauri::command]
pub fn fs_edit_file(
    file_path: String,
    old_string: String,
    new_string: String,
    replace_all: Option<bool>,
) -> Result<EditFileResult, String> {
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
}

#[tauri::command]
pub fn fs_glob(
    pattern: String,
    path: Option<String>,
    limit: Option<usize>,
) -> Result<GlobResult, String> {
    let max = limit.unwrap_or(MAX_RESULTS);

    // Resolve the pattern relative to the base path
    let full_pattern = if let Some(ref base) = path {
        let base_path = PathBuf::from(base);
        if pattern.starts_with('/') {
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
}

#[tauri::command]
pub fn fs_grep(
    pattern: String,
    path: Option<String>,
    include: Option<String>,
    limit: Option<usize>,
) -> Result<GrepResult, String> {
    let max = limit.unwrap_or(MAX_RESULTS);
    let base = path.unwrap_or_else(|| ".".to_string());
    let base_path = Path::new(&base);

    let re = regex::Regex::new(&pattern).map_err(|e| format!("Invalid regex pattern: {}", e))?;

    // Optional file extension filter
    let include_ext: Option<String> = include.map(|inc| {
        // Handle patterns like "*.rs" or "rs"
        inc.trim_start_matches("*.").trim_start_matches('.').to_string()
    });

    let mut matches = Vec::new();

    let walker = walkdir::WalkDir::new(base_path)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| {
            let name = e.file_name().to_string_lossy();
            !DEFAULT_IGNORES.iter().any(|ign| name == *ign)
        });

    'outer: for entry in walker {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };

        if !entry.file_type().is_file() {
            continue;
        }

        // Check file extension filter
        if let Some(ref ext) = include_ext {
            let file_ext = entry
                .path()
                .extension()
                .map(|e| e.to_string_lossy().to_string())
                .unwrap_or_default();
            if file_ext != *ext {
                continue;
            }
        }

        // Try to read file (skip binary/unreadable files)
        let content = match std::fs::read_to_string(entry.path()) {
            Ok(c) => c,
            Err(_) => continue,
        };

        for (line_num, line) in content.lines().enumerate() {
            if re.is_match(line) {
                let display_line = if line.len() > MAX_LINE_LENGTH {
                    &line[..MAX_LINE_LENGTH]
                } else {
                    line
                };

                matches.push(GrepMatch {
                    file: entry.path().to_string_lossy().to_string(),
                    line: line_num + 1,
                    text: display_line.to_string(),
                });

                if matches.len() >= max {
                    break 'outer;
                }
            }
        }
    }

    let truncated = matches.len() >= max;
    let count = matches.len();

    Ok(GrepResult {
        matches,
        count,
        truncated,
    })
}

#[tauri::command]
pub fn fs_list_dir(
    path: Option<String>,
    ignore: Option<Vec<String>>,
    limit: Option<usize>,
) -> Result<ListDirResult, String> {
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
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_dir() -> tempfile::TempDir {
        tempfile::TempDir::new().unwrap()
    }

    #[test]
    fn read_file_basic() {
        let dir = temp_dir();
        let file = dir.path().join("test.txt");
        fs::write(&file, "line1\nline2\nline3\n").unwrap();

        let result = fs_read_file(file.to_string_lossy().to_string(), None, None, None).unwrap();
        assert_eq!(result.total_lines, 3);
        assert_eq!(result.lines_read, 3);
        assert!(!result.truncated);
        assert!(result.content.contains("line1"));
        assert!(result.content.contains("line2"));
        // Default: no line numbers
        assert!(!result.content.contains("\t"));

        // With line numbers
        let result_ln = fs_read_file(file.to_string_lossy().to_string(), None, None, Some(true)).unwrap();
        assert!(result_ln.content.contains("     1\tline1"));
    }

    #[test]
    fn read_file_with_offset_and_limit() {
        let dir = temp_dir();
        let file = dir.path().join("test.txt");
        fs::write(&file, "a\nb\nc\nd\ne\n").unwrap();

        let result = fs_read_file(file.to_string_lossy().to_string(), Some(1), Some(2), None).unwrap();
        assert_eq!(result.lines_read, 2);
        assert!(result.truncated);
        assert!(result.content.contains("b"));
        assert!(result.content.contains("c"));
        assert!(!result.content.contains("a"));
    }

    #[test]
    fn read_file_not_found() {
        let result = fs_read_file("/nonexistent/file.txt".into(), None, None, None);
        assert!(result.is_err());
    }

    #[test]
    fn write_file_creates_and_writes() {
        let dir = temp_dir();
        let file = dir.path().join("output.txt");

        let result = fs_write_file(file.to_string_lossy().to_string(), "hello world".into()).unwrap();
        assert!(result.success);
        assert_eq!(result.bytes_written, 11);
        assert_eq!(fs::read_to_string(&file).unwrap(), "hello world");
    }

    #[test]
    fn write_file_creates_parent_dirs() {
        let dir = temp_dir();
        let file = dir.path().join("a/b/c/output.txt");

        let result = fs_write_file(file.to_string_lossy().to_string(), "nested".into()).unwrap();
        assert!(result.success);
        assert_eq!(fs::read_to_string(&file).unwrap(), "nested");
    }

    #[test]
    fn edit_file_single_replacement() {
        let dir = temp_dir();
        let file = dir.path().join("test.txt");
        fs::write(&file, "hello world").unwrap();

        let result = fs_edit_file(
            file.to_string_lossy().to_string(),
            "hello".into(),
            "goodbye".into(),
            None,
        )
        .unwrap();

        assert!(result.success);
        assert_eq!(result.replacements, 1);
        assert_eq!(fs::read_to_string(&file).unwrap(), "goodbye world");
    }

    #[test]
    fn edit_file_errors_on_multiple_matches_without_replace_all() {
        let dir = temp_dir();
        let file = dir.path().join("test.txt");
        fs::write(&file, "foo bar foo baz foo").unwrap();

        let result = fs_edit_file(
            file.to_string_lossy().to_string(),
            "foo".into(),
            "qux".into(),
            None,
        );

        assert!(result.is_err());
        assert!(result.unwrap_err().contains("3 occurrences"));
    }

    #[test]
    fn edit_file_replace_all() {
        let dir = temp_dir();
        let file = dir.path().join("test.txt");
        fs::write(&file, "foo bar foo baz foo").unwrap();

        let result = fs_edit_file(
            file.to_string_lossy().to_string(),
            "foo".into(),
            "qux".into(),
            Some(true),
        )
        .unwrap();

        assert_eq!(result.replacements, 3);
        assert_eq!(fs::read_to_string(&file).unwrap(), "qux bar qux baz qux");
    }

    #[test]
    fn edit_file_not_found_error() {
        let result = fs_edit_file(
            "/nonexistent/file.txt".into(),
            "old".into(),
            "new".into(),
            None,
        );
        assert!(result.is_err());
    }

    #[test]
    fn edit_file_string_not_found() {
        let dir = temp_dir();
        let file = dir.path().join("test.txt");
        fs::write(&file, "hello world").unwrap();

        let result = fs_edit_file(
            file.to_string_lossy().to_string(),
            "nonexistent".into(),
            "new".into(),
            None,
        );

        assert!(result.is_err());
        assert!(result.unwrap_err().contains("not found"));
    }

    #[test]
    fn glob_finds_files() {
        let dir = temp_dir();
        fs::write(dir.path().join("a.txt"), "a").unwrap();
        fs::write(dir.path().join("b.txt"), "b").unwrap();
        fs::write(dir.path().join("c.rs"), "c").unwrap();

        let pattern = format!("{}/*.txt", dir.path().display());
        let result = fs_glob(pattern, None, None).unwrap();
        assert_eq!(result.count, 2);
        assert!(!result.truncated);
    }

    #[test]
    fn glob_respects_limit() {
        let dir = temp_dir();
        for i in 0..10 {
            fs::write(dir.path().join(format!("{}.txt", i)), "x").unwrap();
        }

        let pattern = format!("{}/*.txt", dir.path().display());
        let result = fs_glob(pattern, None, Some(3)).unwrap();
        assert_eq!(result.count, 3);
        assert!(result.truncated);
    }

    #[test]
    fn grep_finds_matches() {
        let dir = temp_dir();
        fs::write(dir.path().join("test.txt"), "hello world\nfoo bar\nhello again\n").unwrap();

        let result = fs_grep(
            "hello".into(),
            Some(dir.path().to_string_lossy().to_string()),
            None,
            None,
        )
        .unwrap();

        assert_eq!(result.count, 2);
        assert_eq!(result.matches[0].line, 1);
        assert_eq!(result.matches[1].line, 3);
    }

    #[test]
    fn grep_with_include_filter() {
        let dir = temp_dir();
        fs::write(dir.path().join("test.txt"), "hello").unwrap();
        fs::write(dir.path().join("test.rs"), "hello").unwrap();

        let result = fs_grep(
            "hello".into(),
            Some(dir.path().to_string_lossy().to_string()),
            Some("*.txt".into()),
            None,
        )
        .unwrap();

        assert_eq!(result.count, 1);
        assert!(result.matches[0].file.ends_with(".txt"));
    }

    #[test]
    fn list_dir_basic() {
        let dir = temp_dir();
        fs::write(dir.path().join("file1.txt"), "a").unwrap();
        fs::create_dir(dir.path().join("subdir")).unwrap();
        fs::write(dir.path().join("subdir/file2.txt"), "b").unwrap();

        let result =
            fs_list_dir(Some(dir.path().to_string_lossy().to_string()), None, None).unwrap();

        assert!(result.count >= 2);
        assert!(result.tree.contains("file1.txt"));
        assert!(result.tree.contains("subdir/"));
    }

    #[test]
    fn list_dir_ignores_defaults() {
        let dir = temp_dir();
        fs::create_dir(dir.path().join("node_modules")).unwrap();
        fs::write(dir.path().join("node_modules/pkg.js"), "x").unwrap();
        fs::write(dir.path().join("app.js"), "y").unwrap();

        let result =
            fs_list_dir(Some(dir.path().to_string_lossy().to_string()), None, None).unwrap();

        assert!(result.tree.contains("app.js"));
        assert!(!result.tree.contains("node_modules"));
    }

    #[test]
    fn list_dir_respects_limit() {
        let dir = temp_dir();
        for i in 0..20 {
            fs::write(dir.path().join(format!("file{}.txt", i)), "x").unwrap();
        }

        let result =
            fs_list_dir(Some(dir.path().to_string_lossy().to_string()), None, Some(5)).unwrap();

        assert_eq!(result.count, 5);
        assert!(result.truncated);
    }
}
