use std::collections::HashMap;

/// Holds the resolved shell environment captured once at startup.
/// On Unix, this runs the user's login shell to source profile scripts
/// (nvm, fnm, volta, rbenv, pyenv, etc.) so child processes get the
/// correct PATH without needing `-l` on every spawn.
pub struct ShellEnv {
    pub vars: HashMap<String, String>,
}

impl ShellEnv {
    /// Resolve the full interactive login shell environment.
    /// On Unix: runs `$SHELL -lic 'env -0'` with a 5s timeout and parses output.
    /// On Windows / on failure: falls back to the current process env.
    pub fn resolve() -> Self {
        #[cfg(unix)]
        {
            use std::sync::mpsc;
            use std::time::Duration;

            let (tx, rx) = mpsc::channel();
            std::thread::spawn(move || {
                let _ = tx.send(resolve_unix());
            });

            match rx.recv_timeout(Duration::from_secs(5)) {
                Ok(Ok(vars)) => {
                    log::info!(
                        "Resolved shell environment ({} vars) from login shell",
                        vars.len()
                    );
                    return ShellEnv { vars };
                }
                Ok(Err(e)) => {
                    log::warn!(
                        "Failed to resolve shell environment, using process env: {}",
                        e
                    );
                }
                Err(_) => {
                    log::warn!(
                        "Shell environment resolution timed out after 5s, using process env"
                    );
                }
            }
        }

        let vars: HashMap<String, String> = std::env::vars().collect();
        log::info!("Using process environment ({} vars)", vars.len());
        ShellEnv { vars }
    }
}

#[cfg(unix)]
fn resolve_unix() -> Result<HashMap<String, String>, String> {
    use std::process::{Command, Stdio};

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into());

    let output = Command::new(&shell)
        .args(["-lic", "env -0"])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .map_err(|e| format!("Failed to spawn '{}': {}", shell, e))?;

    if !output.status.success() {
        return Err(format!("Shell exited with status: {}", output.status));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let vars = parse_env_null(&stdout);

    if vars.is_empty() {
        return Err("No environment variables parsed from shell output".into());
    }

    Ok(vars)
}

/// Parse null-byte separated `KEY=VALUE\0` output from `env -0`.
/// Skips `BASH_FUNC_*` entries and the `_` variable.
pub fn parse_env_null(input: &str) -> HashMap<String, String> {
    let mut vars = HashMap::new();

    for entry in input.split('\0') {
        if entry.is_empty() {
            continue;
        }
        // Split on the first '=' only (values may contain '=')
        let Some((key, value)) = entry.split_once('=') else {
            continue;
        };
        // Skip bash function exports and the _ variable
        if key.starts_with("BASH_FUNC_") || key == "_" {
            continue;
        }
        vars.insert(key.to_string(), value.to_string());
    }

    vars
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_env_null_basic() {
        let input = "HOME=/home/user\0PATH=/usr/bin:/bin\0SHELL=/bin/bash\0";
        let vars = parse_env_null(input);

        assert_eq!(vars.get("HOME"), Some(&"/home/user".to_string()));
        assert_eq!(vars.get("PATH"), Some(&"/usr/bin:/bin".to_string()));
        assert_eq!(vars.get("SHELL"), Some(&"/bin/bash".to_string()));
        assert_eq!(vars.len(), 3);
    }

    #[test]
    fn parse_env_null_skips_bash_funcs_and_underscore() {
        let input = "HOME=/home/user\0BASH_FUNC_foo%%=() { echo hi; }\0_=/usr/bin/env\0";
        let vars = parse_env_null(input);

        assert_eq!(vars.get("HOME"), Some(&"/home/user".to_string()));
        assert!(!vars.contains_key("BASH_FUNC_foo%%"));
        assert!(!vars.contains_key("_"));
        assert_eq!(vars.len(), 1);
    }

    #[test]
    fn parse_env_null_handles_values_with_equals() {
        let input = "FOO=bar=baz\0";
        let vars = parse_env_null(input);

        assert_eq!(vars.get("FOO"), Some(&"bar=baz".to_string()));
    }

    #[test]
    fn parse_env_null_handles_empty_input() {
        let vars = parse_env_null("");
        assert!(vars.is_empty());
    }

    #[test]
    fn parse_env_null_handles_empty_values() {
        let input = "EMPTY=\0ALSO_EMPTY=\0";
        let vars = parse_env_null(input);

        assert_eq!(vars.get("EMPTY"), Some(&"".to_string()));
        assert_eq!(vars.get("ALSO_EMPTY"), Some(&"".to_string()));
    }

    #[test]
    fn parse_env_null_handles_multiline_values() {
        let input = "MULTI=line1\nline2\nline3\0NEXT=val\0";
        let vars = parse_env_null(input);

        assert_eq!(
            vars.get("MULTI"),
            Some(&"line1\nline2\nline3".to_string())
        );
        assert_eq!(vars.get("NEXT"), Some(&"val".to_string()));
    }
}
