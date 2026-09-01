use crate::config::AcpProfile;
use hmac::{Hmac, Mac};
#[cfg(windows)]
use process_wrap::tokio::{ChildWrapper, CommandWrap, CreationFlags, JobObject, KillOnDrop};
use sha2::Sha256;
use std::collections::VecDeque;
use std::collections::{BTreeMap, HashMap};
#[cfg(windows)]
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::AsyncReadExt;
#[cfg(not(windows))]
use tokio::process::Child;
use tokio::process::{ChildStdin, ChildStdout, Command};
use tokio::sync::{mpsc, watch};
#[cfg(windows)]
use windows::Win32::System::Threading::CREATE_NO_WINDOW;

#[cfg(windows)]
type ManagedChild = Box<dyn ChildWrapper>;
#[cfg(not(windows))]
type ManagedChild = Child;

const BASELINE_ENV: &[&str] = &[
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "XDG_DATA_HOME",
    "APPDATA",
    "LOCALAPPDATA",
    "USERPROFILE",
    "SYSTEMROOT",
    "SYSTEMDRIVE",
];

#[derive(Clone, PartialEq, Eq)]
pub struct PreparedProcess {
    pub executable: PathBuf,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub env: BTreeMap<String, String>,
    pub profile_fingerprint: String,
}

fn valid_env_name(name: &str) -> bool {
    let mut chars = name.chars();
    matches!(chars.next(), Some('_' | 'A'..='Z' | 'a'..='z'))
        && chars.all(|character| matches!(character, '_' | 'A'..='Z' | 'a'..='z' | '0'..='9'))
}

pub fn prepare_process(
    profile: &AcpProfile,
    cwd: &Path,
    parent_env: &HashMap<String, String>,
    bundled_node_bin: Option<&Path>,
    fingerprint_key: &[u8],
) -> Result<PreparedProcess, String> {
    if profile.disabled {
        return Err(format!("ACP profile is disabled: {}", profile.id));
    }
    if profile.executable.is_empty() || profile.executable.contains('\0') {
        return Err(format!(
            "ACP profile {} has an invalid executable",
            profile.id
        ));
    }
    if profile.inherit_env.iter().any(|name| !valid_env_name(name)) {
        return Err(format!(
            "ACP profile {} contains an invalid inherited environment name",
            profile.id
        ));
    }
    if profile
        .args
        .iter()
        .chain(&profile.inherit_env)
        .any(|value| value.contains('\0'))
    {
        return Err(format!("ACP profile {} contains a NUL", profile.id));
    }

    let cwd = cwd
        .canonicalize()
        .map_err(|error| format!("Failed to canonicalize ACP working directory: {error}"))?;
    if !cwd.is_dir() {
        return Err(format!(
            "ACP working directory is not a directory: {}",
            cwd.display()
        ));
    }

    let path_value = effective_path(parent_env.get("PATH"), bundled_node_bin)?;
    let (executable, args) = resolve_direct_command(
        &profile.executable,
        &profile.args,
        &cwd,
        &path_value,
        parent_env,
    )?;

    let mut env = BTreeMap::new();
    for name in BASELINE_ENV {
        if let Some(value) = parent_env.get(*name) {
            env.insert((*name).to_string(), value.clone());
        }
    }
    env.insert("PATH".into(), path_value);
    for name in &profile.inherit_env {
        if let Some(value) = parent_env.get(name) {
            env.insert(name.clone(), value.clone());
        }
    }
    let profile_fingerprint =
        runtime_profile_fingerprint(fingerprint_key, &executable, &args, &cwd, &env)?;
    Ok(PreparedProcess {
        executable,
        args,
        cwd,
        env,
        profile_fingerprint,
    })
}

fn resolve_direct_command(
    executable: &str,
    args: &[String],
    cwd: &Path,
    path_value: &str,
    parent_env: &HashMap<String, String>,
) -> Result<(PathBuf, Vec<String>), String> {
    #[cfg(windows)]
    if executable.eq_ignore_ascii_case("npx") {
        for directory in std::env::split_paths(path_value) {
            if let Ok((node, cli)) = resolve_windows_npx_layout(&directory) {
                let cli = cli
                    .into_os_string()
                    .into_string()
                    .map_err(|_| "Windows npx-cli.js path is not valid Unicode".to_string())?;
                let mut direct_args = Vec::with_capacity(args.len() + 1);
                direct_args.push(cli);
                direct_args.extend_from_slice(args);
                return Ok((node, direct_args));
            }
        }
        return Err(
            "ACP npx profile requires a direct Windows node.exe + npx-cli.js installation".into(),
        );
    }
    Ok((
        resolve_executable(executable, cwd, path_value, parent_env)?,
        args.to_vec(),
    ))
}

#[cfg(any(windows, test))]
fn resolve_windows_npx_layout(directory: &Path) -> Result<(PathBuf, PathBuf), String> {
    let shim = directory.join("npx.cmd");
    let node = directory.join("node.exe");
    let cli = directory.join("node_modules/npm/bin/npx-cli.js");
    if !shim.is_file() || !node.is_file() || !cli.is_file() {
        return Err("Directory is not a complete Windows npx installation".into());
    }
    let node = node
        .canonicalize()
        .map_err(|error| format!("Failed to canonicalize Windows node.exe: {error}"))?;
    let cli = cli
        .canonicalize()
        .map_err(|error| format!("Failed to canonicalize Windows npx-cli.js: {error}"))?;
    Ok((node, cli))
}

fn runtime_profile_fingerprint(
    fingerprint_key: &[u8],
    executable: &Path,
    args: &[String],
    cwd: &Path,
    env: &BTreeMap<String, String>,
) -> Result<String, String> {
    fn add(hasher: &mut Hmac<Sha256>, value: &[u8]) {
        hasher.update(&(value.len() as u64).to_be_bytes());
        hasher.update(value);
    }

    let mut hasher = Hmac::<Sha256>::new_from_slice(fingerprint_key)
        .map_err(|_| "ACP fingerprint key is invalid".to_string())?;
    add(&mut hasher, b"thechat-acp-profile-v1");
    add(
        &mut hasher,
        executable.as_os_str().to_string_lossy().as_bytes(),
    );
    add(&mut hasher, cwd.as_os_str().to_string_lossy().as_bytes());
    for arg in args {
        add(&mut hasher, arg.as_bytes());
    }
    for (name, value) in env {
        add(&mut hasher, name.as_bytes());
        add(&mut hasher, value.as_bytes());
    }
    Ok(hasher
        .finalize()
        .into_bytes()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

fn effective_path(
    current: Option<&String>,
    bundled_node_bin: Option<&Path>,
) -> Result<String, String> {
    let mut paths: Vec<PathBuf> = current
        .map(|value| std::env::split_paths(value).collect())
        .unwrap_or_default();
    if let Some(directory) = bundled_node_bin {
        if !paths.iter().any(|path| path == directory) {
            paths.insert(0, directory.to_path_buf());
        }
    }
    std::env::join_paths(paths)
        .map_err(|error| format!("Invalid PATH for ACP process: {error}"))?
        .into_string()
        .map_err(|_| "ACP PATH is not valid Unicode".to_string())
}

fn resolve_executable(
    executable: &str,
    cwd: &Path,
    path_value: &str,
    parent_env: &HashMap<String, String>,
) -> Result<PathBuf, String> {
    let configured = Path::new(executable);
    let mut candidates = Vec::new();
    if configured.is_absolute() || configured.components().count() > 1 {
        let base = if configured.is_absolute() {
            configured.to_path_buf()
        } else {
            cwd.join(configured)
        };
        append_platform_candidates(&mut candidates, base, parent_env);
    } else {
        for directory in std::env::split_paths(path_value) {
            append_platform_candidates(&mut candidates, directory.join(configured), parent_env);
        }
    }

    for candidate in candidates {
        if is_direct_executable(&candidate) {
            return candidate
                .canonicalize()
                .map_err(|error| format!("Failed to canonicalize ACP executable: {error}"));
        }
    }
    Err(format!(
        "ACP executable not found or not executable: {executable}"
    ))
}

#[cfg(not(windows))]
fn append_platform_candidates(
    candidates: &mut Vec<PathBuf>,
    base: PathBuf,
    _parent_env: &HashMap<String, String>,
) {
    candidates.push(base);
}

#[cfg(windows)]
fn append_platform_candidates(
    candidates: &mut Vec<PathBuf>,
    base: PathBuf,
    parent_env: &HashMap<String, String>,
) {
    if base.extension().is_some() {
        candidates.push(base);
        return;
    }
    let path_ext = parent_env
        .get("PATHEXT")
        .map(String::as_str)
        .unwrap_or(".COM;.EXE");
    for extension in path_ext.split(';') {
        if extension.eq_ignore_ascii_case(".exe") || extension.eq_ignore_ascii_case(".com") {
            let mut candidate: OsString = base.as_os_str().to_owned();
            candidate.push(extension);
            candidates.push(PathBuf::from(candidate));
        }
    }
}

#[cfg(unix)]
fn is_direct_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    path.metadata()
        .map(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(windows)]
fn is_direct_executable(path: &Path) -> bool {
    path.is_file()
        && path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| {
                extension.eq_ignore_ascii_case("exe") || extension.eq_ignore_ascii_case("com")
            })
}

#[cfg(not(any(unix, windows)))]
fn is_direct_executable(path: &Path) -> bool {
    path.is_file()
}

const STDERR_TAIL_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExitReport {
    pub success: bool,
    pub code: Option<i32>,
}

pub struct SpawnedAcpProcess {
    stdin: Option<ChildStdin>,
    stdout: Option<ChildStdout>,
    terminate_tx: mpsc::UnboundedSender<()>,
    exit_rx: watch::Receiver<Option<ExitReport>>,
    stderr_tail: Arc<Mutex<VecDeque<u8>>>,
}

impl SpawnedAcpProcess {
    pub fn take_stdin(&mut self) -> Option<ChildStdin> {
        self.stdin.take()
    }

    pub fn take_stdout(&mut self) -> Option<ChildStdout> {
        self.stdout.take()
    }

    pub fn take_stdio(&mut self) -> Result<(ChildStdin, ChildStdout), String> {
        let stdin = self
            .take_stdin()
            .ok_or_else(|| "ACP stdin was already taken".to_string())?;
        let stdout = self
            .take_stdout()
            .ok_or_else(|| "ACP stdout was already taken".to_string())?;
        Ok((stdin, stdout))
    }

    #[cfg(test)]
    pub fn stderr_tail(&self) -> String {
        let tail = self
            .stderr_tail
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        String::from_utf8_lossy(&tail.iter().copied().collect::<Vec<_>>()).into_owned()
    }

    pub fn stderr_captured_bytes(&self) -> usize {
        self.stderr_tail
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .len()
    }

    pub async fn wait_for_exit(&mut self) -> Result<ExitReport, String> {
        loop {
            if let Some(report) = *self.exit_rx.borrow() {
                return Ok(report);
            }
            self.exit_rx
                .changed()
                .await
                .map_err(|_| "ACP process supervisor stopped without an exit status".to_string())?;
        }
    }

    pub async fn terminate(&mut self) -> Result<ExitReport, String> {
        let _ = self.terminate_tx.send(());
        self.wait_for_exit().await
    }
}

impl Drop for SpawnedAcpProcess {
    fn drop(&mut self) {
        let _ = self.terminate_tx.send(());
    }
}

pub fn spawn_process(prepared: PreparedProcess) -> Result<SpawnedAcpProcess, String> {
    let mut command = Command::new(&prepared.executable);
    command
        .args(&prepared.args)
        .current_dir(&prepared.cwd)
        .env_clear()
        .envs(&prepared.env)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    #[cfg(unix)]
    unsafe {
        command.pre_exec(|| {
            if libc::setpgid(0, 0) == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }

    let mut child = spawn_managed_child(command)
        .map_err(|error| format!("Failed to spawn ACP adapter ({:?})", error.kind()))?;
    let pid = child
        .id()
        .ok_or_else(|| "Spawned ACP process has no process id".to_string())?;
    #[cfg(windows)]
    let (stdin, stdout, stderr) = (
        child
            .stdin()
            .take()
            .ok_or_else(|| "Failed to open ACP stdin".to_string())?,
        child
            .stdout()
            .take()
            .ok_or_else(|| "Failed to open ACP stdout".to_string())?,
        child
            .stderr()
            .take()
            .ok_or_else(|| "Failed to open ACP stderr".to_string())?,
    );
    #[cfg(not(windows))]
    let (stdin, stdout, stderr) = (
        child
            .stdin
            .take()
            .ok_or_else(|| "Failed to open ACP stdin".to_string())?,
        child
            .stdout
            .take()
            .ok_or_else(|| "Failed to open ACP stdout".to_string())?,
        child
            .stderr
            .take()
            .ok_or_else(|| "Failed to open ACP stderr".to_string())?,
    );

    let stderr_tail = Arc::new(Mutex::new(VecDeque::with_capacity(STDERR_TAIL_BYTES)));
    let stderr_for_task = Arc::clone(&stderr_tail);
    tokio::spawn(async move {
        drain_stderr(stderr, stderr_for_task).await;
    });

    let (terminate_tx, mut terminate_rx) = mpsc::unbounded_channel();
    let (exit_tx, exit_rx) = watch::channel(None);
    tokio::spawn(async move {
        let result = tokio::select! {
            status = wait_for_child_exit(&mut child) => {
                #[cfg(unix)]
                cleanup_unix_process_group(pid).await;
                status
            },
            _ = terminate_rx.recv() => terminate_child_tree(&mut child, pid).await,
        };
        let report = match result {
            Ok(status) => ExitReport {
                success: status.success(),
                code: status.code(),
            },
            Err(_) => ExitReport {
                success: false,
                code: None,
            },
        };
        let _ = exit_tx.send(Some(report));
    });

    Ok(SpawnedAcpProcess {
        stdin: Some(stdin),
        stdout: Some(stdout),
        terminate_tx,
        exit_rx,
        stderr_tail,
    })
}

#[cfg(windows)]
fn spawn_managed_child(command: Command) -> std::io::Result<ManagedChild> {
    let mut command: CommandWrap = command.into();
    command.wrap(KillOnDrop);
    command.wrap(CreationFlags(CREATE_NO_WINDOW));
    command.wrap(JobObject);
    command.spawn()
}

#[cfg(not(windows))]
fn spawn_managed_child(mut command: Command) -> std::io::Result<ManagedChild> {
    command.spawn()
}

#[cfg(windows)]
async fn wait_for_child_exit(
    child: &mut ManagedChild,
) -> std::io::Result<std::process::ExitStatus> {
    loop {
        if let Some(status) = child.try_wait()? {
            let _ = child.start_kill();
            let _ = child.wait().await;
            return Ok(status);
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

#[cfg(not(windows))]
async fn wait_for_child_exit(
    child: &mut ManagedChild,
) -> std::io::Result<std::process::ExitStatus> {
    child.wait().await
}

async fn drain_stderr(mut stderr: tokio::process::ChildStderr, tail: Arc<Mutex<VecDeque<u8>>>) {
    let mut buffer = [0_u8; 4096];
    loop {
        let read = match stderr.read(&mut buffer).await {
            Ok(0) | Err(_) => break,
            Ok(read) => read,
        };
        let mut tail = tail.lock().unwrap_or_else(|error| error.into_inner());
        tail.extend(&buffer[..read]);
        while tail.len() > STDERR_TAIL_BYTES {
            tail.pop_front();
        }
    }
}

#[cfg(unix)]
async fn cleanup_unix_process_group(pid: u32) {
    let process_group = -(pid as i32);
    unsafe {
        libc::kill(process_group, libc::SIGTERM);
    }
    tokio::time::sleep(Duration::from_millis(100)).await;
    unsafe {
        libc::kill(process_group, libc::SIGKILL);
    }
}

#[cfg(unix)]
async fn terminate_child_tree(
    child: &mut Child,
    pid: u32,
) -> std::io::Result<std::process::ExitStatus> {
    let process_group = -(pid as i32);
    unsafe {
        libc::kill(process_group, libc::SIGTERM);
    }
    let status = match tokio::time::timeout(Duration::from_secs(2), child.wait()).await {
        Ok(status) => status?,
        Err(_) => {
            unsafe {
                libc::kill(process_group, libc::SIGKILL);
            }
            child.wait().await?
        }
    };
    cleanup_unix_process_group(pid).await;
    Ok(status)
}

#[cfg(windows)]
async fn terminate_child_tree(
    child: &mut ManagedChild,
    _pid: u32,
) -> std::io::Result<std::process::ExitStatus> {
    child.start_kill()?;
    child.wait().await
}

#[cfg(not(any(unix, windows)))]
async fn terminate_child_tree(
    child: &mut ManagedChild,
    _pid: u32,
) -> std::io::Result<std::process::ExitStatus> {
    let _ = child.start_kill();
    child.wait().await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::AcpProfile;
    use std::collections::HashMap;

    #[test]
    fn windows_npx_layout_maps_to_node_and_cli_script() {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("nodejs");
        std::fs::create_dir_all(bin.join("node_modules/npm/bin")).unwrap();
        std::fs::write(bin.join("node.exe"), b"node").unwrap();
        std::fs::write(bin.join("npx.cmd"), b"shim").unwrap();
        std::fs::write(bin.join("node_modules/npm/bin/npx-cli.js"), b"cli").unwrap();

        let (node, cli) = resolve_windows_npx_layout(&bin).unwrap();
        assert_eq!(node, bin.join("node.exe").canonicalize().unwrap());
        assert_eq!(
            cli,
            bin.join("node_modules/npm/bin/npx-cli.js")
                .canonicalize()
                .unwrap()
        );
    }

    #[cfg(unix)]
    #[test]
    fn prepared_process_uses_literal_argv_canonical_cwd_and_allowlisted_env() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("bin");
        let cwd = dir.path().join("project");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::create_dir_all(&cwd).unwrap();
        let executable = bin.join("fake-agent");
        std::fs::write(&executable, b"#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();

        let mut parent_env = HashMap::new();
        parent_env.insert("PATH".into(), bin.to_string_lossy().into_owned());
        parent_env.insert("HOME".into(), "/safe-home".into());
        parent_env.insert("THECHAT_SECRET_SENTINEL".into(), "must-not-leak".into());
        let profile = AcpProfile {
            id: "fake".into(),
            name: "Fake".into(),
            executable: "fake-agent".into(),
            args: vec!["$HOME;touch /tmp/pwned".into(), "with spaces".into()],
            inherit_env: Vec::new(),
            disabled: false,
        };

        let prepared = prepare_process(&profile, &cwd, &parent_env, None, &[7_u8; 32]).unwrap();

        assert_eq!(prepared.executable, executable.canonicalize().unwrap());
        assert_eq!(prepared.cwd, cwd.canonicalize().unwrap());
        assert_eq!(prepared.args, profile.args);
        assert_eq!(
            prepared.env.get("HOME").map(String::as_str),
            Some("/safe-home")
        );
        assert!(!prepared.env.contains_key("THECHAT_SECRET_SENTINEL"));
    }

    #[cfg(unix)]
    #[test]
    fn runtime_fingerprint_changes_when_an_inherited_value_changes() {
        let cwd = tempfile::tempdir().unwrap();
        let profile = AcpProfile {
            id: "fingerprint-profile".into(),
            name: "Fingerprint profile".into(),
            executable: "/usr/bin/env".into(),
            args: vec!["--ignore-environment".into()],
            inherit_env: vec!["ACP_TEST_TOKEN".into()],
            disabled: false,
        };
        let first = prepare_process(
            &profile,
            cwd.path(),
            &HashMap::from([
                ("PATH".into(), "/usr/bin:/bin".into()),
                ("ACP_TEST_TOKEN".into(), "first-secret-value".into()),
            ]),
            None,
            &[7_u8; 32],
        )
        .unwrap();
        let second = prepare_process(
            &profile,
            cwd.path(),
            &HashMap::from([
                ("PATH".into(), "/usr/bin:/bin".into()),
                ("ACP_TEST_TOKEN".into(), "second-secret-value".into()),
            ]),
            None,
            &[7_u8; 32],
        )
        .unwrap();

        assert_ne!(first.profile_fingerprint, second.profile_fingerprint);
        assert_eq!(first.profile_fingerprint.len(), 64);
        assert!(!first.profile_fingerprint.contains("first-secret-value"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn spawned_process_really_clears_unapproved_environment() {
        use tokio::io::AsyncReadExt;

        let cwd = tempfile::tempdir().unwrap();
        let executable = Path::new("/usr/bin/env").canonicalize().unwrap();
        let prepared = PreparedProcess {
            executable,
            args: Vec::new(),
            cwd: cwd.path().canonicalize().unwrap(),
            env: BTreeMap::from([
                ("PATH".into(), "/usr/bin:/bin".into()),
                ("SAFE_EXPLICIT".into(), "visible".into()),
            ]),
            profile_fingerprint: "test-fingerprint".into(),
        };
        std::env::set_var("THECHAT_SECRET_SENTINEL", "must-not-leak");

        let mut process = spawn_process(prepared).unwrap();
        let mut stdout = process.take_stdout().unwrap();
        let mut output = String::new();
        stdout.read_to_string(&mut output).await.unwrap();
        process.wait_for_exit().await.unwrap();
        std::env::remove_var("THECHAT_SECRET_SENTINEL");

        assert!(output.contains("SAFE_EXPLICIT=visible"), "{output}");
        assert!(!output.contains("THECHAT_SECRET_SENTINEL"), "{output}");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn normal_parent_exit_cleans_up_descendant_process_group() {
        let cwd = tempfile::tempdir().unwrap();
        let pid_file = cwd.path().join("descendant.pid");
        let prepared = PreparedProcess {
            executable: Path::new("/bin/sh").canonicalize().unwrap(),
            args: vec![
                "-c".into(),
                format!("sleep 30 & echo $! > '{}'", pid_file.display()),
            ],
            cwd: cwd.path().canonicalize().unwrap(),
            env: BTreeMap::from([("PATH".into(), "/usr/bin:/bin".into())]),
            profile_fingerprint: "test-fingerprint".into(),
        };

        let mut process = spawn_process(prepared).unwrap();
        tokio::time::timeout(Duration::from_secs(5), process.wait_for_exit())
            .await
            .expect("adapter parent did not exit")
            .unwrap();
        let pid: i32 = std::fs::read_to_string(&pid_file)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        let descendant_gone = tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let running = unsafe { libc::kill(pid, 0) } == 0;
                if !running {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        })
        .await
        .is_ok();

        assert!(
            descendant_gone,
            "descendant process {pid} survived parent exit"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn explicit_termination_kills_term_resistant_descendants() {
        let cwd = tempfile::tempdir().unwrap();
        let pid_file = cwd.path().join("resistant.pid");
        let prepared = PreparedProcess {
            executable: Path::new("/bin/sh").canonicalize().unwrap(),
            args: vec![
                "-c".into(),
                format!(
                    "trap 'exit 0' TERM; sh -c 'trap \"\" TERM; echo $$ > \"{}\"; while :; do sleep 1; done' & wait",
                    pid_file.display()
                ),
            ],
            cwd: cwd.path().canonicalize().unwrap(),
            env: BTreeMap::from([("PATH".into(), "/usr/bin:/bin".into())]),
            profile_fingerprint: "test-fingerprint".into(),
        };
        let mut process = spawn_process(prepared).unwrap();
        tokio::time::timeout(Duration::from_secs(2), async {
            while !pid_file.exists() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("descendant pid was not written");
        let pid: i32 = std::fs::read_to_string(&pid_file)
            .unwrap()
            .trim()
            .parse()
            .unwrap();

        tokio::time::timeout(Duration::from_secs(5), process.terminate())
            .await
            .expect("explicit termination timed out")
            .unwrap();
        let descendant_gone = tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let running = unsafe { libc::kill(pid, 0) } == 0;
                let zombie = std::fs::read_to_string(format!("/proc/{pid}/stat"))
                    .ok()
                    .and_then(|stat| stat.split_whitespace().nth(2).map(str::to_string))
                    .is_some_and(|state| state == "Z");
                if !running || zombie {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        })
        .await
        .is_ok();
        if !descendant_gone {
            unsafe { libc::kill(pid, libc::SIGKILL) };
        }
        assert!(
            descendant_gone,
            "TERM-resistant descendant {pid} survived termination"
        );
    }
}
