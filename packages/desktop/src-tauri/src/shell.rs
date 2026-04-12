use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::Emitter;
use tokio::io::{AsyncBufReadExt, BufReader};

/// Tracks running shell processes so they can be killed on demand.
pub struct ShellProcesses {
    pids: Mutex<HashMap<String, u32>>,
}

impl ShellProcesses {
    pub fn new() -> Self {
        Self {
            pids: Mutex::new(HashMap::new()),
        }
    }
}

#[derive(Debug, Serialize, Clone)]
struct ShellOutputEvent {
    process_id: String,
    data: String,
    stream: String,
}

#[derive(Debug, Serialize)]
pub struct ShellResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
    pub timed_out: bool,
}

#[tauri::command]
#[tracing::instrument(skip(app, processes, shell_env))]
pub async fn execute_shell_command<R: tauri::Runtime>(
    command: String,
    timeout: Option<u64>,
    workdir: Option<String>,
    process_id: Option<String>,
    app: tauri::AppHandle<R>,
    processes: tauri::State<'_, Arc<ShellProcesses>>,
    shell_env: tauri::State<'_, Arc<crate::env::ShellEnv>>,
) -> Result<ShellResult, String> {
    let timeout_secs = timeout.unwrap_or(120);
    let process_id = process_id.unwrap_or_default();
    let mut cmd;

    #[cfg(not(windows))]
    {
        cmd = tokio::process::Command::new(&shell_env.shell);
        cmd.args(["-c", &command]);
    }

    #[cfg(windows)]
    {
        // cmd.exe doesn't follow MSVC C runtime escaping rules, so using
        // `args(["/C", &command])` mangles quotes. Use raw_arg to pass the
        // command string through without Rust's automatic escaping.
        let mut std_cmd = std::process::Command::new(&shell_env.shell);
        {
            use std::os::windows::process::CommandExt as _;
            std_cmd.raw_arg(format!("/C {command}"));
        }
        cmd = tokio::process::Command::from(std_cmd);
    }

    cmd.stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);

    // Apply the resolved shell environment
    #[cfg(not(windows))]
    for (k, v) in &shell_env.vars {
        cmd.env(k, v);
    }

    // Create a new process group so we can kill the entire tree
    #[cfg(unix)]
    unsafe {
        cmd.pre_exec(|| {
            if libc::setpgid(0, 0) == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x00000200;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
    }

    if let Some(ref dir) = workdir {
        cmd.current_dir(dir);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn shell: {}", e))?;

    let pid = child.id();

    // Track the process for cancellation
    if let Some(pid) = pid {
        if !process_id.is_empty() {
            processes
                .pids
                .lock()
                .unwrap()
                .insert(process_id.clone(), pid);
        }
    }

    // Set up async readers that feed output through a channel
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<(String, String)>();

    if let Some(stdout) = child.stdout.take() {
        let tx = tx.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                if tx.send(("stdout".into(), line)).is_err() {
                    break;
                }
            }
        });
    }

    if let Some(stderr) = child.stderr.take() {
        let tx = tx.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                if tx.send(("stderr".into(), line)).is_err() {
                    break;
                }
            }
        });
    }

    // Drop the original sender so rx finishes when both reader tasks complete
    drop(tx);

    // Collect output in a spawned task, emitting events along the way
    let emit_events = !process_id.is_empty();
    let app_for_collect = app.clone();
    let pid_for_collect = process_id.clone();

    let collect_handle = tokio::spawn(async move {
        let mut stdout_buf = String::new();
        let mut stderr_buf = String::new();

        while let Some((stream, line)) = rx.recv().await {
            if emit_events {
                let _ = app_for_collect.emit(
                    "shell-output",
                    ShellOutputEvent {
                        process_id: pid_for_collect.clone(),
                        data: line.clone(),
                        stream: stream.clone(),
                    },
                );
            }
            if stream == "stdout" {
                stdout_buf.push_str(&line);
                stdout_buf.push('\n');
            } else {
                stderr_buf.push_str(&line);
                stderr_buf.push('\n');
            }
        }

        (stdout_buf, stderr_buf)
    });

    // Wait for the child to exit, with timeout
    let timeout_duration = tokio::time::Duration::from_secs(timeout_secs);
    let wait_result = tokio::time::timeout(timeout_duration, child.wait()).await;

    let (exit_code, timed_out) = match wait_result {
        Ok(Ok(status)) => (status.code().unwrap_or(-1), false),
        Ok(Err(e)) => return Err(format!("Process error: {}", e)),
        Err(_) => {
            // Timeout — kill the process group gracefully
            if let Some(pid) = pid {
                graceful_kill(pid).await;
            }
            // Reap the child (should return quickly after kill)
            let _ = child.wait().await;
            (-1, true)
        }
    };

    // Wait for output collection to finish (process is dead, pipes are closing)
    let (stdout, stderr) = collect_handle
        .await
        .unwrap_or_else(|_| (String::new(), String::new()));

    // Clean up process tracking
    if !process_id.is_empty() {
        processes.pids.lock().unwrap().remove(&process_id);
    }

    Ok(ShellResult {
        stdout,
        stderr,
        exit_code,
        timed_out,
    })
}

#[tauri::command]
#[tracing::instrument(skip(processes))]
pub async fn kill_shell_process(
    process_id: String,
    processes: tauri::State<'_, Arc<ShellProcesses>>,
) -> Result<(), String> {
    let pid = processes.pids.lock().unwrap().get(&process_id).copied();

    match pid {
        Some(pid) => {
            graceful_kill(pid).await;
            processes.pids.lock().unwrap().remove(&process_id);
            Ok(())
        }
        None => Err(format!("No running process with id: {}", process_id)),
    }
}

/// Send SIGTERM to the process group, wait 200ms, then SIGKILL if still alive.
async fn graceful_kill(pid: u32) {
    #[cfg(unix)]
    {
        let pgid = -(pid as i32);
        unsafe {
            libc::kill(pgid, libc::SIGTERM);
        }
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        unsafe {
            libc::kill(pgid, libc::SIGKILL);
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/F", "/T"])
            .status()
            .await;
    }
}
