use serde::Serialize;
use std::process::Command;

#[derive(Debug, Serialize)]
pub struct ShellResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
    pub timed_out: bool,
}

#[tauri::command]
pub fn execute_shell_command(command: String, timeout: Option<u64>, workdir: Option<String>) -> Result<ShellResult, String> {
    let timeout_secs = timeout.unwrap_or(120);
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());

    let mut cmd = Command::new(&shell);
    cmd.args(["-l", "-c", &command])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    if let Some(ref dir) = workdir {
        cmd.current_dir(dir);
    }

    let mut child = cmd.spawn()
        .map_err(|e| format!("Failed to spawn shell: {}", e))?;

    let timeout_duration = std::time::Duration::from_secs(timeout_secs);
    let start = std::time::Instant::now();

    // Poll for completion with timeout
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let stdout = child
                    .stdout
                    .take()
                    .map(|mut s| {
                        let mut buf = String::new();
                        std::io::Read::read_to_string(&mut s, &mut buf).unwrap_or(0);
                        buf
                    })
                    .unwrap_or_default();

                let stderr = child
                    .stderr
                    .take()
                    .map(|mut s| {
                        let mut buf = String::new();
                        std::io::Read::read_to_string(&mut s, &mut buf).unwrap_or(0);
                        buf
                    })
                    .unwrap_or_default();

                return Ok(ShellResult {
                    stdout,
                    stderr,
                    exit_code: status.code().unwrap_or(-1),
                    timed_out: false,
                });
            }
            Ok(None) => {
                // Still running
                if start.elapsed() >= timeout_duration {
                    let _ = child.kill();
                    let _ = child.wait();

                    let stdout = child
                        .stdout
                        .take()
                        .map(|mut s| {
                            let mut buf = String::new();
                            std::io::Read::read_to_string(&mut s, &mut buf).unwrap_or(0);
                            buf
                        })
                        .unwrap_or_default();

                    let stderr = child
                        .stderr
                        .take()
                        .map(|mut s| {
                            let mut buf = String::new();
                            std::io::Read::read_to_string(&mut s, &mut buf).unwrap_or(0);
                            buf
                        })
                        .unwrap_or_default();

                    return Ok(ShellResult {
                        stdout,
                        stderr,
                        exit_code: -1,
                        timed_out: true,
                    });
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            Err(e) => {
                return Err(format!("Failed to wait for process: {}", e));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_result_serializes_correctly() {
        let result = ShellResult {
            stdout: "hello\n".into(),
            stderr: "".into(),
            exit_code: 0,
            timed_out: false,
        };
        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains("\"stdout\":\"hello\\n\""));
        assert!(json.contains("\"exit_code\":0"));
        assert!(json.contains("\"timed_out\":false"));
    }

    #[test]
    fn shell_result_serializes_timeout() {
        let result = ShellResult {
            stdout: "partial".into(),
            stderr: "".into(),
            exit_code: -1,
            timed_out: true,
        };
        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains("\"timed_out\":true"));
        assert!(json.contains("\"exit_code\":-1"));
    }

    #[test]
    fn shell_result_has_all_fields() {
        let result = ShellResult {
            stdout: "out".into(),
            stderr: "err".into(),
            exit_code: 1,
            timed_out: false,
        };
        let value: serde_json::Value = serde_json::to_value(&result).unwrap();
        assert!(value.get("stdout").is_some());
        assert!(value.get("stderr").is_some());
        assert!(value.get("exit_code").is_some());
        assert!(value.get("timed_out").is_some());
    }
}
