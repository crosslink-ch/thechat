use crate::config::{load_config, McpServerConfig};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use tauri::Manager;

// -- JSON-RPC types --

#[derive(Debug, Serialize)]
struct JsonRpcRequest {
    jsonrpc: String,
    id: u64,
    method: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    params: Option<Value>,
}

#[derive(Debug, Serialize)]
struct JsonRpcNotification {
    jsonrpc: String,
    method: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    params: Option<Value>,
}

#[derive(Debug, Deserialize)]
struct JsonRpcResponse {
    #[allow(dead_code)]
    jsonrpc: String,
    id: Option<u64>,
    result: Option<Value>,
    error: Option<JsonRpcError>,
}

#[derive(Debug, Deserialize)]
struct JsonRpcError {
    #[allow(dead_code)]
    code: i64,
    message: String,
}

// -- MCP tool info returned to frontend --

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpToolInfo {
    pub server: String,
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}

// -- Shell escaping --

/// Single-quote a string for safe use in a shell command.
/// If the string is simple (alphanumeric + common safe chars), return it as-is.
fn shell_escape(s: &str) -> String {
    if s.is_empty() {
        return "''".into();
    }
    // Safe characters that don't need quoting
    if s.chars()
        .all(|c| c.is_ascii_alphanumeric() || "-_=/.,:@".contains(c))
    {
        return s.into();
    }
    // Wrap in single quotes, escaping any embedded single quotes
    format!("'{}'", s.replace('\'', "'\\''"))
}

// -- McpClient: manages a single MCP server --

enum Transport {
    Stdio {
        child: Child,
        stdin: Option<std::process::ChildStdin>,
        stdout: BufReader<std::process::ChildStdout>,
    },
    Http {
        client: reqwest::blocking::Client,
        url: String,
        session_id: Option<String>,
        auth_token: Option<String>,
    },
}

struct McpClient {
    transport: Transport,
    next_id: AtomicU64,
}

/// Extract a JSON-RPC response from an SSE body.
/// Scans `data:` lines, parses as JsonRpcResponse, returns the result for the matching ID.
fn parse_sse_response(body: &str, expected_id: u64) -> Result<Value, String> {
    for line in body.lines() {
        let line = line.trim();
        if let Some(data) = line.strip_prefix("data:") {
            let data = data.trim();
            if data.is_empty() {
                continue;
            }
            if let Ok(resp) = serde_json::from_str::<JsonRpcResponse>(data) {
                if resp.id == Some(expected_id) {
                    if let Some(err) = resp.error {
                        return Err(format!("MCP error: {}", err.message));
                    }
                    return Ok(resp.result.unwrap_or(Value::Null));
                }
            }
        }
    }
    Err(format!(
        "No JSON-RPC response with id={} found in SSE stream",
        expected_id
    ))
}

impl McpClient {
    /// Build a shell command string, quoting each piece for safe embedding in `sh -c`.
    fn shell_quoted(command: &str, args: &[String]) -> String {
        let mut parts = vec![shell_escape(command)];
        for arg in args {
            parts.push(shell_escape(arg));
        }
        parts.join(" ")
    }

    fn spawn(
        server_name: &str,
        command: &str,
        args: &[String],
        shell_env: &HashMap<String, String>,
        config_env: &HashMap<String, String>,
    ) -> Result<Self, String> {
        let mut cmd;

        // On Unix, spawn through a shell so it uses the resolved PATH for
        // command lookup. The resolved env (captured at startup from a login
        // shell) is applied via cmd.env(), so we don't need `-l` here.
        #[cfg(not(windows))]
        {
            let shell = shell_env
                .get("SHELL")
                .cloned()
                .unwrap_or_else(|| "/bin/bash".into());
            let shell_cmd = Self::shell_quoted(command, args);
            cmd = Command::new(&shell);
            cmd.args(["-c", &shell_cmd]);
        }

        // On Windows, PATH is globally configured so we spawn the command directly.
        #[cfg(windows)]
        {
            cmd = Command::new(command);
            cmd.args(args);
        }

        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        // Apply resolved shell environment first, then config overrides
        for (k, v) in shell_env {
            cmd.env(k, v);
        }
        for (k, v) in config_env {
            cmd.env(k, v);
        }
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Failed to spawn MCP server '{}': {}", command, e))?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Failed to open stdin for MCP server".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Failed to open stdout for MCP server".to_string())?;

        // Drain stderr in a background thread to prevent pipe buffer deadlock
        // and log server errors for debugging.
        if let Some(stderr) = child.stderr.take() {
            let name = server_name.to_string();
            std::thread::spawn(move || {
                let reader = BufReader::new(stderr);
                for line in reader.lines() {
                    match line {
                        Ok(line) if !line.is_empty() => {
                            tracing::warn!(server = %name, "MCP server stderr: {}", line);
                        }
                        Err(_) => break,
                        _ => {}
                    }
                }
            });
        }

        Ok(McpClient {
            transport: Transport::Stdio {
                child,
                stdin: Some(stdin),
                stdout: BufReader::new(stdout),
            },
            next_id: AtomicU64::new(1),
        })
    }

    fn connect_http(url: &str, headers: &HashMap<String, String>) -> Result<Self, String> {
        use reqwest::header::{HeaderMap, HeaderName, HeaderValue};

        let mut default_headers = HeaderMap::new();
        for (k, v) in headers {
            let name = HeaderName::from_bytes(k.as_bytes())
                .map_err(|e| format!("Invalid header name '{}': {}", k, e))?;
            let value = HeaderValue::from_str(v)
                .map_err(|e| format!("Invalid header value for '{}': {}", k, e))?;
            default_headers.insert(name, value);
        }

        let client = reqwest::blocking::Client::builder()
            .default_headers(default_headers)
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|e| format!("Failed to build HTTP client: {}", e))?;

        Ok(McpClient {
            transport: Transport::Http {
                client,
                url: url.to_string(),
                session_id: None,
                auth_token: None,
            },
            next_id: AtomicU64::new(1),
        })
    }

    fn send_request(&mut self, method: &str, params: Option<Value>) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let request = JsonRpcRequest {
            jsonrpc: "2.0".into(),
            id,
            method: method.into(),
            params,
        };

        match &mut self.transport {
            Transport::Stdio { stdin, stdout, .. } => {
                let mut line = serde_json::to_string(&request)
                    .map_err(|e| format!("Failed to serialize request: {}", e))?;
                line.push('\n');
                let stdin = stdin
                    .as_mut()
                    .ok_or_else(|| "MCP server stdin is closed".to_string())?;
                stdin
                    .write_all(line.as_bytes())
                    .map_err(|e| format!("Failed to write to MCP server stdin: {}", e))?;
                stdin
                    .flush()
                    .map_err(|e| format!("Failed to flush MCP server stdin: {}", e))?;

                // Read lines until we find a response with our ID
                loop {
                    let mut buf = String::new();
                    let bytes_read = stdout
                        .read_line(&mut buf)
                        .map_err(|e| format!("Failed to read from MCP server stdout: {}", e))?;
                    if bytes_read == 0 {
                        return Err("MCP server closed stdout unexpectedly".into());
                    }

                    let buf = buf.trim();
                    if buf.is_empty() {
                        continue;
                    }

                    let resp: JsonRpcResponse = match serde_json::from_str(buf) {
                        Ok(r) => r,
                        Err(_) => continue, // skip non-JSON lines (e.g. logging)
                    };

                    // Skip notifications (no id)
                    if resp.id != Some(id) {
                        continue;
                    }

                    if let Some(err) = resp.error {
                        return Err(format!("MCP error: {}", err.message));
                    }
                    return Ok(resp.result.unwrap_or(Value::Null));
                }
            }
            Transport::Http {
                client,
                url,
                session_id,
                auth_token,
            } => {
                let body = serde_json::to_string(&request)
                    .map_err(|e| format!("Failed to serialize request: {}", e))?;

                let mut req = client
                    .post(url.as_str())
                    .header("Content-Type", "application/json")
                    .header("Accept", "application/json, text/event-stream");

                if let Some(sid) = session_id.as_deref() {
                    req = req.header("Mcp-Session-Id", sid);
                }

                if let Some(token) = auth_token.as_deref() {
                    req = req.header("Authorization", format!("Bearer {}", token));
                }

                let response = req
                    .body(body)
                    .send()
                    .map_err(|e| format!("HTTP request failed: {}", e))?;

                // Capture session ID from response
                if let Some(sid) = response.headers().get("mcp-session-id") {
                    if let Ok(s) = sid.to_str() {
                        *session_id = Some(s.to_string());
                    }
                }

                let status = response.status();
                if !status.is_success() {
                    let text = response.text().unwrap_or_default();
                    return Err(format!("HTTP {} from MCP server: {}", status, text));
                }

                let content_type = response
                    .headers()
                    .get("content-type")
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or("")
                    .to_string();

                let text = response
                    .text()
                    .map_err(|e| format!("Failed to read HTTP response body: {}", e))?;

                if content_type.contains("text/event-stream") {
                    parse_sse_response(&text, id)
                } else {
                    // application/json — direct JSON-RPC response
                    let resp: JsonRpcResponse = serde_json::from_str(&text)
                        .map_err(|e| format!("Failed to parse JSON-RPC response: {}", e))?;
                    if let Some(err) = resp.error {
                        return Err(format!("MCP error: {}", err.message));
                    }
                    Ok(resp.result.unwrap_or(Value::Null))
                }
            }
        }
    }

    fn send_notification(&mut self, method: &str, params: Option<Value>) -> Result<(), String> {
        let notification = JsonRpcNotification {
            jsonrpc: "2.0".into(),
            method: method.into(),
            params,
        };

        match &mut self.transport {
            Transport::Stdio { stdin, .. } => {
                let mut line = serde_json::to_string(&notification)
                    .map_err(|e| format!("Failed to serialize notification: {}", e))?;
                line.push('\n');
                let stdin = stdin
                    .as_mut()
                    .ok_or_else(|| "MCP server stdin is closed".to_string())?;
                stdin
                    .write_all(line.as_bytes())
                    .map_err(|e| format!("Failed to write to MCP server stdin: {}", e))?;
                stdin
                    .flush()
                    .map_err(|e| format!("Failed to flush MCP server stdin: {}", e))?;
                Ok(())
            }
            Transport::Http {
                client,
                url,
                session_id,
                auth_token,
            } => {
                let body = serde_json::to_string(&notification)
                    .map_err(|e| format!("Failed to serialize notification: {}", e))?;

                let mut req = client
                    .post(url.as_str())
                    .header("Content-Type", "application/json");

                if let Some(sid) = session_id.as_deref() {
                    req = req.header("Mcp-Session-Id", sid);
                }

                if let Some(token) = auth_token.as_deref() {
                    req = req.header("Authorization", format!("Bearer {}", token));
                }

                // Fire-and-forget: ignore response
                let _ = req.body(body).send();
                Ok(())
            }
        }
    }

    fn initialize(&mut self) -> Result<(), String> {
        let params = json!({
            "protocolVersion": "2025-03-26",
            "capabilities": {},
            "clientInfo": {
                "name": "thechat",
                "version": "0.1.0"
            }
        });

        let _result = self.send_request("initialize", Some(params))?;
        self.send_notification("notifications/initialized", None)?;
        Ok(())
    }

    fn list_tools(&mut self) -> Result<Vec<Value>, String> {
        let result = self.send_request("tools/list", None)?;
        let tools = result
            .get("tools")
            .and_then(|t| t.as_array())
            .cloned()
            .unwrap_or_default();
        Ok(tools)
    }

    fn call_tool(&mut self, name: &str, arguments: Value) -> Result<String, String> {
        let params = json!({
            "name": name,
            "arguments": arguments,
        });
        let result = self.send_request("tools/call", Some(params))?;

        // Check for isError flag
        let is_error = result
            .get("isError")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        // Extract text content from the result
        let content = result
            .get("content")
            .and_then(|c| c.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|item| {
                        if item.get("type").and_then(|t| t.as_str()) == Some("text") {
                            item.get("text").and_then(|t| t.as_str()).map(String::from)
                        } else {
                            // For non-text content, serialize it
                            Some(serde_json::to_string(item).unwrap_or_default())
                        }
                    })
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .unwrap_or_else(|| serde_json::to_string_pretty(&result).unwrap_or_default());

        if is_error {
            Err(content)
        } else {
            Ok(content)
        }
    }

    fn set_auth_token(&mut self, token: &str) {
        if let Transport::Http { auth_token, .. } = &mut self.transport {
            *auth_token = Some(token.to_string());
        }
    }

    #[cfg(test)]
    fn session_id(&self) -> Option<&str> {
        match &self.transport {
            Transport::Http { session_id, .. } => session_id.as_deref(),
            _ => None,
        }
    }

    fn shutdown(&mut self) {
        match &mut self.transport {
            Transport::Stdio { stdin, child, .. } => {
                // Drop stdin to signal EOF
                stdin.take();
                // Kill the process and wait for it
                let _ = child.kill();
                let _ = child.wait();
            }
            Transport::Http {
                client,
                url,
                session_id,
                auth_token,
            } => {
                // Send DELETE to terminate the session, ignore errors
                if let Some(sid) = session_id.as_deref() {
                    let mut req = client.delete(url.as_str()).header("Mcp-Session-Id", sid);
                    if let Some(token) = auth_token.as_deref() {
                        req = req.header("Authorization", format!("Bearer {}", token));
                    }
                    let _ = req.send();
                }
            }
        }
    }
}

// -- McpManager: manages multiple clients --

pub struct McpManager {
    clients: Mutex<HashMap<String, Arc<Mutex<McpClient>>>>,
    initialized: AtomicBool,
    /// Per-server initialization lock to prevent concurrent init of the same server.
    /// Each entry is an (is_done, condvar) pair. Waiters block on the condvar until
    /// is_done becomes true, then read the client from `clients`.
    initializing: Mutex<HashMap<String, Arc<(Mutex<bool>, Condvar)>>>,
}

impl McpManager {
    pub fn new() -> Self {
        McpManager {
            clients: Mutex::new(HashMap::new()),
            initialized: AtomicBool::new(false),
            initializing: Mutex::new(HashMap::new()),
        }
    }
}

// -- Tauri commands --

const MCP_INIT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

/// Initialize a single MCP server: connect (stdio or HTTP), handshake, list tools.
/// Returns the client and discovered tools, or an error.
/// If `auth_token` is provided, it will be set on HTTP transports for authentication.
/// The work runs in a background thread with a 20s timeout to prevent hangs from
/// slow or unresponsive servers.
fn init_server(
    server_name: &str,
    config: &McpServerConfig,
    auth_token: Option<&str>,
    shell_env: &HashMap<String, String>,
) -> Result<(McpClient, Vec<McpToolInfo>), String> {
    let (tx, rx) = std::sync::mpsc::channel();

    let name = server_name.to_string();
    let cfg = config.clone();
    let token = auth_token.map(|s| s.to_string());
    let env = shell_env.clone();

    std::thread::spawn(move || {
        let result = init_server_inner(&name, &cfg, token.as_deref(), &env);
        // If the receiver timed out and dropped, send will fail — that's fine.
        let _ = tx.send(result);
    });

    rx.recv_timeout(MCP_INIT_TIMEOUT).map_err(|_| {
        format!(
            "MCP server '{}' initialization timed out after {}s",
            server_name,
            MCP_INIT_TIMEOUT.as_secs()
        )
    })?
}

fn init_server_inner(
    server_name: &str,
    config: &McpServerConfig,
    auth_token: Option<&str>,
    shell_env: &HashMap<String, String>,
) -> Result<(McpClient, Vec<McpToolInfo>), String> {
    let mut client = if let Some(url) = &config.url {
        let mut c = McpClient::connect_http(url, &config.headers)?;
        if let Some(token) = auth_token {
            c.set_auth_token(token);
        }
        c
    } else if let Some(command) = &config.command {
        McpClient::spawn(server_name, command, &config.args, shell_env, &config.env)?
    } else {
        return Err("MCP server must have either 'command' (stdio) or 'url' (HTTP)".into());
    };

    if let Err(e) = client.initialize() {
        client.shutdown();
        return Err(format!("Handshake failed: {}", e));
    }

    let raw_tools = match client.list_tools() {
        Ok(t) => t,
        Err(e) => {
            client.shutdown();
            return Err(format!("tools/list failed: {}", e));
        }
    };

    let tools: Vec<McpToolInfo> = raw_tools
        .into_iter()
        .map(|tool| {
            let name = tool
                .get("name")
                .and_then(|n| n.as_str())
                .unwrap_or("unknown")
                .to_string();
            let description = tool
                .get("description")
                .and_then(|d| d.as_str())
                .unwrap_or("")
                .to_string();
            let input_schema = tool
                .get("inputSchema")
                .cloned()
                .unwrap_or(json!({"type": "object", "properties": {}}));

            McpToolInfo {
                server: server_name.to_string(),
                name,
                description,
                input_schema,
            }
        })
        .collect();

    Ok((client, tools))
}

#[tauri::command]
#[tracing::instrument(skip(app, manager, shell_env))]
pub async fn mcp_initialize<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    manager: tauri::State<'_, Arc<McpManager>>,
    shell_env: tauri::State<'_, Arc<crate::env::ShellEnv>>,
) -> Result<(), String> {
    use tauri::Emitter;

    if manager.initialized.swap(true, Ordering::SeqCst) {
        tracing::info!("MCP servers already initialized, skipping");
        return Ok(());
    }

    let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let config = tokio::task::spawn_blocking(move || load_config(&config_dir))
        .await
        .map_err(|e| format!("Task join error: {}", e))??;

    if config.mcp_servers.is_empty() {
        return Ok(());
    }

    let manager = Arc::clone(&manager);
    let env_vars = shell_env.vars.clone();

    for (server_name, server_config) in config.mcp_servers {
        if server_config.disabled {
            tracing::info!(server = %server_name, "skipping MCP server (disabled)");
            continue;
        }
        if server_config.requires_auth {
            tracing::info!(server = %server_name, "skipping MCP server (requires auth)");
            continue;
        }
        if server_config.lazy {
            tracing::info!(server = %server_name, "skipping MCP server (lazy, will load on demand)");
            continue;
        }

        let manager = Arc::clone(&manager);
        let app = app.clone();
        let env = env_vars.clone();

        std::thread::spawn(move || {
            tracing::info!(server = %server_name, "initializing MCP server");

            match init_server(&server_name, &server_config, None, &env) {
                Ok((client, tools)) => {
                    tracing::info!(
                        server = %server_name,
                        tool_count = tools.len(),
                        "MCP server ready"
                    );

                    // Register the client
                    if let Ok(mut clients) = manager.clients.lock() {
                        clients.insert(server_name.clone(), Arc::new(Mutex::new(client)));
                    }

                    // Emit tools to the frontend
                    if let Err(e) = app.emit("mcp-tools-ready", &tools) {
                        tracing::error!(server = %server_name, error = %e, "failed to emit mcp-tools-ready");
                    }
                }
                Err(e) => {
                    tracing::error!(server = %server_name, error = %e, "failed to initialize MCP server");
                }
            }
        });
    }

    Ok(())
}

/// Initialize MCP servers that require authentication, or update the token for
/// already-initialized auth servers. Called when the user logs in or when the JWT
/// refreshes (every ~15 minutes).
#[tauri::command]
#[tracing::instrument(skip(app, token, manager, shell_env))]
pub async fn mcp_initialize_authed<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    token: String,
    manager: tauri::State<'_, Arc<McpManager>>,
    shell_env: tauri::State<'_, Arc<crate::env::ShellEnv>>,
) -> Result<(), String> {
    use tauri::Emitter;

    let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let config = tokio::task::spawn_blocking(move || load_config(&config_dir))
        .await
        .map_err(|e| format!("Task join error: {}", e))??;
    let env_vars = shell_env.vars.clone();

    for (server_name, server_config) in config.mcp_servers {
        if server_config.disabled {
            tracing::info!(server = %server_name, "skipping auth MCP server (disabled)");
            continue;
        }
        if !server_config.requires_auth {
            continue;
        }
        if server_config.lazy {
            tracing::info!(
                server = %server_name,
                "skipping auth MCP server (lazy, will load on demand)"
            );
            continue;
        }

        // If already initialized, just update the token
        {
            let clients = manager
                .clients
                .lock()
                .map_err(|e| format!("Lock error: {}", e))?;
            if let Some(client_arc) = clients.get(&server_name) {
                if let Ok(mut client) = client_arc.lock() {
                    client.set_auth_token(&token);
                }
                tracing::info!(server = %server_name, "updated auth token for MCP server");
                continue;
            }
        }

        // Not yet initialized — initialize with the auth token
        let token = token.clone();
        let manager = Arc::clone(&manager);
        let app = app.clone();
        let env = env_vars.clone();

        std::thread::spawn(move || {
            tracing::info!(server = %server_name, "initializing auth MCP server");

            match init_server(&server_name, &server_config, Some(&token), &env) {
                Ok((client, tools)) => {
                    tracing::info!(
                        server = %server_name,
                        tool_count = tools.len(),
                        "auth MCP server ready"
                    );

                    if let Ok(mut clients) = manager.clients.lock() {
                        clients.insert(server_name.clone(), Arc::new(Mutex::new(client)));
                    }

                    if let Err(e) = app.emit("mcp-tools-ready", &tools) {
                        tracing::error!(
                            server = %server_name, error = %e,
                            "failed to emit mcp-tools-ready"
                        );
                    }
                }
                Err(e) => {
                    tracing::error!(
                        server = %server_name, error = %e,
                        "failed to initialize auth MCP server"
                    );
                }
            }
        });
    }

    Ok(())
}

/// Initialize specific MCP servers by name (blocking).
/// Used by the skill tool to lazily load MCP servers on demand.
/// For already-initialized servers, re-lists their tools and returns them.
/// The caller manages adding tools to the session — no event is emitted.
#[tauri::command]
#[tracing::instrument(skip(app, token, manager, shell_env))]
pub async fn mcp_initialize_servers<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    names: Vec<String>,
    token: Option<String>,
    manager: tauri::State<'_, Arc<McpManager>>,
    shell_env: tauri::State<'_, Arc<crate::env::ShellEnv>>,
) -> Result<Vec<McpToolInfo>, String> {
    let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let config = load_config(&config_dir)?;
    let manager = Arc::clone(&manager);
    let env_vars = shell_env.vars.clone();

    // Run blocking I/O (process spawn, handshake, list_tools) off the main thread.
    tokio::task::spawn_blocking(move || {
        let mut all_tools: Vec<McpToolInfo> = Vec::new();

        for name in &names {
            // Helper closure to list tools from an already-initialized client
            let list_from_client = |name: &str, token: &Option<String>| -> Result<Vec<McpToolInfo>, String> {
                let clients = manager
                    .clients
                    .lock()
                    .map_err(|e| format!("Lock error: {}", e))?;
                if let Some(client_arc) = clients.get(name) {
                    let mut client = client_arc
                        .lock()
                        .map_err(|e| format!("Client lock error: {}", e))?;
                    if let Some(ref t) = token {
                        client.set_auth_token(t);
                    }
                    let raw_tools = client.list_tools()?;
                    return Ok(raw_tools
                        .into_iter()
                        .map(|tool| McpToolInfo {
                            server: name.to_string(),
                            name: tool.get("name").and_then(|n| n.as_str()).unwrap_or("unknown").to_string(),
                            description: tool.get("description").and_then(|d| d.as_str()).unwrap_or("").to_string(),
                            input_schema: tool.get("inputSchema").cloned().unwrap_or(json!({"type": "object", "properties": {}})),
                        })
                        .collect());
                }
                Err(format!("Client '{}' not found after init", name))
            };

            // If already initialized, re-list tools from the existing client
            {
                let clients = manager
                    .clients
                    .lock()
                    .map_err(|e| format!("Lock error: {}", e))?;
                if clients.contains_key(name) {
                    drop(clients);
                    tracing::info!(server = %name, "MCP server already initialized, re-listing tools");
                    all_tools.extend(list_from_client(name, &token)?);
                    continue;
                }
            }

            // Check if another caller is already initializing this server
            let wait_pair = {
                let mut init_map = manager
                    .initializing
                    .lock()
                    .map_err(|e| format!("Initializing lock error: {}", e))?;

                if let Some(pair) = init_map.get(name) {
                    // Another caller is initializing — wait for it
                    Some(Arc::clone(pair))
                } else {
                    // We are the first caller — claim this server
                    init_map.insert(
                        name.clone(),
                        Arc::new((Mutex::new(false), Condvar::new())),
                    );
                    None
                }
            };

            if let Some(pair) = wait_pair {
                // Wait for the other caller to finish initializing
                tracing::info!(
                    server = %name,
                    "MCP server is being initialized by another caller, waiting"
                );
                let (lock, cvar) = &*pair;
                let guard = lock
                    .lock()
                    .map_err(|e| format!("Condvar lock error: {}", e))?;
                let _guard = cvar
                    .wait_while(guard, |done| !*done)
                    .map_err(|e| format!("Condvar wait error: {}", e))?;

                // The other caller finished — read tools from the now-initialized client
                tracing::info!(
                    server = %name,
                    "MCP server initialization completed by another caller, re-listing tools"
                );
                all_tools.extend(list_from_client(name, &token)?);
                continue;
            }

            // We are the initializer for this server
            let server_config = config
                .mcp_servers
                .get(name)
                .ok_or_else(|| format!("MCP server '{}' not found in config", name))?;

            // Use provided token for auth servers, or None
            let auth_token = if server_config.requires_auth {
                token.as_deref()
            } else {
                None
            };

            tracing::info!(server = %name, "lazily initializing MCP server");

            let init_result = init_server(name, server_config, auth_token, &env_vars);

            // Notify waiters regardless of success/failure, then clean up
            {
                let init_map = manager.initializing.lock();
                if let Ok(mut map) = init_map {
                    if let Some(pair) = map.remove(name) {
                        let (lock, cvar) = &*pair;
                        if let Ok(mut done) = lock.lock() {
                            *done = true;
                        }
                        cvar.notify_all();
                    }
                }
            }

            match init_result {
                Ok((client, tools)) => {
                    tracing::info!(
                        server = %name,
                        tool_count = tools.len(),
                        "MCP server ready"
                    );

                    if let Ok(mut clients) = manager.clients.lock() {
                        clients.insert(name.clone(), Arc::new(Mutex::new(client)));
                    }

                    all_tools.extend(tools);
                }
                Err(e) => {
                    tracing::error!(server = %name, error = %e, "failed to initialize MCP server");
                    return Err(format!("Failed to initialize MCP server '{}': {}", name, e));
                }
            }
        }

        Ok(all_tools)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
#[tracing::instrument(skip(args, manager))]
pub async fn mcp_call_tool(
    server: String,
    tool: String,
    args: Value,
    manager: tauri::State<'_, Arc<McpManager>>,
) -> Result<String, String> {
    let client_arc = {
        let clients = manager
            .clients
            .lock()
            .map_err(|e| format!("Lock error: {}", e))?;

        clients
            .get(&server)
            .ok_or_else(|| format!("MCP server '{}' not found", server))?
            .clone()
    };

    // Run blocking I/O (stdio read_line / HTTP send) on a thread pool
    // so the main thread stays free for UI events.
    tokio::task::spawn_blocking(move || {
        let mut client = client_arc
            .lock()
            .map_err(|e| format!("Client lock error: {}", e))?;

        client.call_tool(&tool, args)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
#[tracing::instrument(skip(manager))]
pub async fn mcp_shutdown(manager: tauri::State<'_, Arc<McpManager>>) -> Result<(), String> {
    let manager = Arc::clone(&manager);
    tokio::task::spawn_blocking(move || {
        let mut clients = manager
            .clients
            .lock()
            .map_err(|e| format!("Lock error: {}", e))?;

        for (name, client_arc) in clients.drain() {
            tracing::info!(server = %name, "shutting down MCP server");
            if let Ok(mut client) = client_arc.lock() {
                client.shutdown();
            }
        }

        manager.initialized.store(false, Ordering::SeqCst);

        Ok(())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_rpc_request_serializes_correctly() {
        let req = JsonRpcRequest {
            jsonrpc: "2.0".into(),
            id: 1,
            method: "initialize".into(),
            params: Some(json!({"protocolVersion": "2024-11-05"})),
        };
        let json = serde_json::to_string(&req).unwrap();
        assert!(json.contains("\"jsonrpc\":\"2.0\""));
        assert!(json.contains("\"id\":1"));
        assert!(json.contains("\"method\":\"initialize\""));
    }

    #[test]
    fn json_rpc_request_omits_null_params() {
        let req = JsonRpcRequest {
            jsonrpc: "2.0".into(),
            id: 1,
            method: "tools/list".into(),
            params: None,
        };
        let json = serde_json::to_string(&req).unwrap();
        assert!(!json.contains("params"));
    }

    #[test]
    fn json_rpc_notification_serializes_correctly() {
        let notif = JsonRpcNotification {
            jsonrpc: "2.0".into(),
            method: "notifications/initialized".into(),
            params: None,
        };
        let json = serde_json::to_string(&notif).unwrap();
        assert!(json.contains("\"method\":\"notifications/initialized\""));
        assert!(!json.contains("id"));
    }

    #[test]
    fn json_rpc_response_deserializes_result() {
        let json = r#"{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}"#;
        let resp: JsonRpcResponse = serde_json::from_str(json).unwrap();
        assert_eq!(resp.id, Some(1));
        assert!(resp.result.is_some());
        assert!(resp.error.is_none());
    }

    #[test]
    fn json_rpc_response_deserializes_error() {
        let json =
            r#"{"jsonrpc":"2.0","id":2,"error":{"code":-32601,"message":"Method not found"}}"#;
        let resp: JsonRpcResponse = serde_json::from_str(json).unwrap();
        assert_eq!(resp.id, Some(2));
        assert!(resp.result.is_none());
        assert_eq!(resp.error.as_ref().unwrap().message, "Method not found");
    }

    #[test]
    fn mcp_tool_info_serializes() {
        let info = McpToolInfo {
            server: "test".into(),
            name: "read_file".into(),
            description: "Read a file".into(),
            input_schema: json!({"type": "object", "properties": {"path": {"type": "string"}}}),
        };
        let json = serde_json::to_string(&info).unwrap();
        assert!(json.contains("\"server\":\"test\""));
        assert!(json.contains("\"name\":\"read_file\""));
    }

    #[test]
    fn mcp_manager_new_has_no_clients() {
        let manager = McpManager::new();
        let clients = manager.clients.lock().unwrap();
        assert!(clients.is_empty());
    }

    #[test]
    fn shell_escape_simple_strings() {
        assert_eq!(shell_escape("npx"), "npx");
        assert_eq!(shell_escape("/usr/bin/node"), "/usr/bin/node");
        assert_eq!(shell_escape("-y"), "-y");
        assert_eq!(
            shell_escape("@modelcontextprotocol/server-filesystem"),
            "@modelcontextprotocol/server-filesystem"
        );
    }

    #[test]
    fn shell_escape_strings_with_spaces() {
        assert_eq!(shell_escape("hello world"), "'hello world'");
        assert_eq!(shell_escape("/path/to/my dir"), "'/path/to/my dir'");
    }

    #[test]
    fn shell_escape_strings_with_quotes() {
        assert_eq!(shell_escape("it's"), "'it'\\''s'");
    }

    #[test]
    fn shell_escape_empty_string() {
        assert_eq!(shell_escape(""), "''");
    }

    #[test]
    fn shell_quoted_builds_full_command() {
        let cmd = McpClient::shell_quoted(
            "npx",
            &[
                "-y".into(),
                "@modelcontextprotocol/server-filesystem".into(),
                "/tmp".into(),
            ],
        );
        assert_eq!(cmd, "npx -y @modelcontextprotocol/server-filesystem /tmp");
    }

    #[test]
    fn shell_quoted_escapes_spaces_in_args() {
        let cmd = McpClient::shell_quoted("node", &["my script.js".into()]);
        assert_eq!(cmd, "node 'my script.js'");
    }

    #[test]
    fn parse_sse_single_data_line() {
        let body =
            "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"tools\":[]}}\n\n";
        let result = parse_sse_response(body, 1).unwrap();
        assert_eq!(result, json!({"tools": []}));
    }

    #[test]
    fn parse_sse_multiple_data_lines() {
        // Two SSE events, only the second matches our ID
        let body = "\
            data: {\"jsonrpc\":\"2.0\",\"id\":99,\"result\":\"wrong\"}\n\n\
            data: {\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"ok\":true}}\n\n";
        let result = parse_sse_response(body, 2).unwrap();
        assert_eq!(result, json!({"ok": true}));
    }

    #[test]
    fn parse_sse_no_matching_id() {
        let body = "data: {\"jsonrpc\":\"2.0\",\"id\":5,\"result\":null}\n\n";
        let result = parse_sse_response(body, 999);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("id=999"));
    }

    #[test]
    fn parse_sse_error_response() {
        let body =
            "data: {\"jsonrpc\":\"2.0\",\"id\":1,\"error\":{\"code\":-32600,\"message\":\"Bad request\"}}\n\n";
        let result = parse_sse_response(body, 1);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Bad request"));
    }

    // ---------------------------------------------------------------
    // Integration tests — spawn real MCP servers via npx
    // ---------------------------------------------------------------

    use std::net::TcpListener;
    use tempfile::TempDir;

    /// RAII guard that kills a child process on drop (even on panic).
    struct ChildGuard(Option<Child>);

    impl Drop for ChildGuard {
        fn drop(&mut self) {
            if let Some(ref mut child) = self.0 {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }

    /// Spawn `@modelcontextprotocol/server-filesystem` over stdio.
    /// Returns the connected+initialized client and a TempDir it's scoped to.
    fn spawn_stdio_test_server() -> (McpClient, TempDir) {
        let tmp = TempDir::new().expect("create temp dir");
        let process_env: HashMap<String, String> = std::env::vars().collect();
        let mut client = McpClient::spawn(
            "test-fs-server",
            "npx",
            &[
                "-y".into(),
                "@modelcontextprotocol/server-filesystem".into(),
                tmp.path().to_str().unwrap().into(),
            ],
            &process_env,
            &HashMap::new(),
        )
        .expect("spawn stdio MCP server");
        client.initialize().expect("initialize stdio server");
        (client, tmp)
    }

    /// Bind to port 0 to let the OS assign a free port, then return it.
    fn find_free_port() -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind to port 0");
        listener.local_addr().unwrap().port()
    }

    /// Poll until `port` is accepting TCP connections (or timeout).
    fn wait_for_port(port: u16, timeout: std::time::Duration) -> Result<(), String> {
        let start = std::time::Instant::now();
        while start.elapsed() < timeout {
            if std::net::TcpStream::connect(("127.0.0.1", port)).is_ok() {
                return Ok(());
            }
            std::thread::sleep(std::time::Duration::from_millis(200));
        }
        Err(format!("Port {} not ready after {:?}", port, timeout))
    }

    /// Spawn `@modelcontextprotocol/server-everything streamableHttp`
    /// listening on a free port. Returns the process guard and the port.
    fn spawn_http_test_server() -> (ChildGuard, u16) {
        let port = find_free_port();

        let child;

        #[cfg(not(windows))]
        {
            let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
            child = Command::new(&shell)
                .args([
                    "-l",
                    "-c",
                    "npx -y @modelcontextprotocol/server-everything streamableHttp",
                ])
                .env("PORT", port.to_string())
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .expect("spawn HTTP MCP server");
        }

        #[cfg(windows)]
        {
            let shell = std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".into());
            child = Command::new(&shell)
                .args([
                    "/C",
                    "npx -y @modelcontextprotocol/server-everything streamableHttp",
                ])
                .env("PORT", port.to_string())
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .expect("spawn HTTP MCP server");
        }

        wait_for_port(port, std::time::Duration::from_secs(30))
            .expect("HTTP server should become ready");

        (ChildGuard(Some(child)), port)
    }

    // -- Stdio transport integration tests --
    // These spawn real MCP servers and are slow (~6s). Skipped by default;
    // run with `cargo test -- --ignored` to include them.

    #[test]
    #[ignore]
    fn stdio_spawn_and_initialize() {
        let (mut client, _tmp) = spawn_stdio_test_server();
        // If we got here, spawn + initialize succeeded
        client.shutdown();
    }

    #[test]
    #[ignore]
    fn stdio_list_tools() {
        let (mut client, _tmp) = spawn_stdio_test_server();
        let tools = client.list_tools().expect("list_tools");
        let names: Vec<String> = tools
            .iter()
            .filter_map(|t| t.get("name").and_then(|n| n.as_str()).map(String::from))
            .collect();
        assert!(
            names.contains(&"read_file".into()),
            "expected read_file in {names:?}"
        );
        assert!(
            names.contains(&"write_file".into()),
            "expected write_file in {names:?}"
        );
        assert!(
            names.contains(&"list_directory".into()),
            "expected list_directory in {names:?}"
        );
        client.shutdown();
    }

    #[test]
    #[ignore]
    fn stdio_call_tool_list_directory() {
        let (mut client, tmp) = spawn_stdio_test_server();
        let result = client.call_tool(
            "list_directory",
            json!({"path": tmp.path().to_str().unwrap()}),
        );
        assert!(result.is_ok(), "list_directory failed: {:?}", result.err());
        client.shutdown();
    }

    #[test]
    #[ignore]
    fn stdio_call_tool_read_write_roundtrip() {
        let (mut client, tmp) = spawn_stdio_test_server();
        let file_path = tmp.path().join("test.txt");
        let content = "hello from integration test";

        client
            .call_tool(
                "write_file",
                json!({
                    "path": file_path.to_str().unwrap(),
                    "content": content,
                }),
            )
            .expect("write_file");

        let read_result = client
            .call_tool("read_file", json!({"path": file_path.to_str().unwrap()}))
            .expect("read_file");

        assert!(
            read_result.contains(content),
            "read_file result should contain written content, got: {read_result}"
        );
        client.shutdown();
    }

    #[test]
    #[ignore]
    fn stdio_call_tool_error() {
        let (mut client, _tmp) = spawn_stdio_test_server();
        let result = client.call_tool(
            "read_file",
            json!({"path": "/nonexistent/path/that/does/not/exist.txt"}),
        );
        assert!(result.is_err(), "expected error for nonexistent file");
        client.shutdown();
    }

    #[test]
    #[ignore]
    fn stdio_shutdown() {
        let (mut client, _tmp) = spawn_stdio_test_server();
        client.shutdown();
        // After shutdown, stdin is closed so send_request should fail
        let result = client.send_request("tools/list", None);
        assert!(result.is_err(), "expected error after shutdown");
    }

    #[test]
    #[ignore]
    fn stdio_init_server_lifecycle() {
        let tmp = TempDir::new().expect("create temp dir");
        let config = McpServerConfig {
            command: Some("npx".into()),
            args: vec![
                "-y".into(),
                "@modelcontextprotocol/server-filesystem".into(),
                tmp.path().to_str().unwrap().into(),
            ],
            env: HashMap::new(),
            url: None,
            headers: HashMap::new(),
            requires_auth: false,
            lazy: false,
            disabled: false,
        };

        let process_env: HashMap<String, String> = std::env::vars().collect();
        let (mut client, tools) =
            init_server("test-stdio", &config, None, &process_env).expect("init_server");
        assert!(!tools.is_empty(), "should discover at least one tool");
        assert!(
            tools.iter().all(|t| t.server == "test-stdio"),
            "all tools should have server='test-stdio'"
        );
        assert!(
            tools.iter().any(|t| t.name == "read_file"),
            "should include read_file tool"
        );
        client.shutdown();
    }

    // -- HTTP transport integration tests --

    #[test]
    #[ignore]
    fn http_connect_and_initialize() {
        let (_guard, port) = spawn_http_test_server();
        let url = format!("http://127.0.0.1:{}/mcp", port);
        let mut client = McpClient::connect_http(&url, &HashMap::new()).expect("connect_http");
        client.initialize().expect("initialize HTTP server");
        client.shutdown();
    }

    #[test]
    #[ignore]
    fn http_list_tools() {
        let (_guard, port) = spawn_http_test_server();
        let url = format!("http://127.0.0.1:{}/mcp", port);
        let mut client = McpClient::connect_http(&url, &HashMap::new()).expect("connect_http");
        client.initialize().expect("initialize");
        let tools = client.list_tools().expect("list_tools");
        assert!(
            tools.len() >= 5,
            "server-everything should expose many tools, got {}",
            tools.len()
        );
        client.shutdown();
    }

    #[test]
    #[ignore]
    fn http_call_tool_echo() {
        let (_guard, port) = spawn_http_test_server();
        let url = format!("http://127.0.0.1:{}/mcp", port);
        let mut client = McpClient::connect_http(&url, &HashMap::new()).expect("connect_http");
        client.initialize().expect("initialize");
        let result = client
            .call_tool("echo", json!({"message": "hello"}))
            .expect("echo tool");
        assert!(
            result.contains("hello"),
            "echo result should contain 'hello', got: {result}"
        );
        client.shutdown();
    }

    #[test]
    #[ignore]
    fn http_session_id_captured() {
        let (_guard, port) = spawn_http_test_server();
        let url = format!("http://127.0.0.1:{}/mcp", port);
        let mut client = McpClient::connect_http(&url, &HashMap::new()).expect("connect_http");
        client.initialize().expect("initialize");
        assert!(
            client.session_id().is_some(),
            "session_id should be captured after initialize"
        );
        client.shutdown();
    }

    #[test]
    #[ignore]
    fn http_init_server_lifecycle() {
        let (_guard, port) = spawn_http_test_server();
        let url = format!("http://127.0.0.1:{}/mcp", port);
        let config = McpServerConfig {
            command: None,
            args: vec![],
            env: HashMap::new(),
            url: Some(url),
            headers: HashMap::new(),
            requires_auth: false,
            lazy: false,
            disabled: false,
        };

        let process_env: HashMap<String, String> = std::env::vars().collect();
        let (mut client, tools) =
            init_server("test-http", &config, None, &process_env).expect("init_server");
        assert!(!tools.is_empty(), "should discover at least one tool");
        assert!(
            tools.iter().all(|t| t.server == "test-http"),
            "all tools should have server='test-http'"
        );
        client.shutdown();
    }

    #[test]
    #[ignore]
    fn http_connect_to_dead_server_fails() {
        // Port 1 is almost certainly not running an MCP server
        let mut client = McpClient::connect_http("http://127.0.0.1:1/mcp", &HashMap::new())
            .expect("connect_http should succeed (no connection yet)");
        let result = client.initialize();
        assert!(
            result.is_err(),
            "initialize should fail against dead server"
        );
    }

    // -- Error handling --

    #[test]
    fn init_server_no_transport_fails() {
        let config = McpServerConfig {
            command: None,
            args: vec![],
            env: HashMap::new(),
            url: None,
            headers: HashMap::new(),
            requires_auth: false,
            lazy: false,
            disabled: false,
        };
        let process_env: HashMap<String, String> = std::env::vars().collect();
        let result = init_server("no-transport", &config, None, &process_env);
        match result {
            Ok(_) => panic!("expected error for config with no transport"),
            Err(e) => assert!(
                e.contains("must have either"),
                "error should mention 'must have either', got: {e}"
            ),
        }
    }
}
