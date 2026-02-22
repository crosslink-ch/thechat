use crate::config::{load_config, McpServerConfig};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

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
    if s.chars().all(|c| c.is_ascii_alphanumeric() || "-_=/.,:@".contains(c)) {
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
        command: &str,
        args: &[String],
        env: &HashMap<String, String>,
    ) -> Result<Self, String> {
        // Spawn through the user's login shell so that profile scripts
        // (nvm, fnm, volta, rbenv, pyenv, etc.) get sourced and PATH is set up.
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
        let shell_cmd = Self::shell_quoted(command, args);

        let mut cmd = Command::new(&shell);
        cmd.args(["-l", "-c", &shell_cmd])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        for (k, v) in env {
            cmd.env(k, v);
        }
        let mut child = cmd.spawn().map_err(|e| {
            format!(
                "Failed to spawn MCP server '{}' (via {}): {}",
                command, shell, e
            )
        })?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Failed to open stdin for MCP server".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Failed to open stdout for MCP server".to_string())?;

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
            } => {
                let body = serde_json::to_string(&notification)
                    .map_err(|e| format!("Failed to serialize notification: {}", e))?;

                let mut req = client
                    .post(url.as_str())
                    .header("Content-Type", "application/json");

                if let Some(sid) = session_id.as_deref() {
                    req = req.header("Mcp-Session-Id", sid);
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
            } => {
                // Send DELETE to terminate the session, ignore errors
                if let Some(sid) = session_id.as_deref() {
                    let _ = client
                        .delete(url.as_str())
                        .header("Mcp-Session-Id", sid)
                        .send();
                }
            }
        }
    }
}

// -- McpManager: manages multiple clients --

pub struct McpManager {
    clients: Mutex<HashMap<String, Arc<Mutex<McpClient>>>>,
    initialized: AtomicBool,
}

impl McpManager {
    pub fn new() -> Self {
        McpManager {
            clients: Mutex::new(HashMap::new()),
            initialized: AtomicBool::new(false),
        }
    }
}

// -- Tauri commands --

/// Initialize a single MCP server: connect (stdio or HTTP), handshake, list tools.
/// Returns the client and discovered tools, or an error.
fn init_server(
    server_name: &str,
    config: &McpServerConfig,
) -> Result<(McpClient, Vec<McpToolInfo>), String> {
    let mut client = if let Some(url) = &config.url {
        McpClient::connect_http(url, &config.headers)?
    } else if let Some(command) = &config.command {
        McpClient::spawn(command, &config.args, &config.env)?
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
pub fn mcp_initialize<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    manager: tauri::State<'_, Arc<McpManager>>,
) -> Result<(), String> {
    use tauri::Emitter;

    if manager.initialized.swap(true, Ordering::SeqCst) {
        log::info!("MCP servers already initialized, skipping");
        return Ok(());
    }

    let config = load_config()?;

    if config.mcp_servers.is_empty() {
        return Ok(());
    }

    let manager = Arc::clone(&manager);

    for (server_name, server_config) in config.mcp_servers {
        let manager = Arc::clone(&manager);
        let app = app.clone();

        std::thread::spawn(move || {
            log::info!("Initializing MCP server: {}", server_name);

            match init_server(&server_name, &server_config) {
                Ok((client, tools)) => {
                    log::info!(
                        "MCP server '{}' ready with {} tools",
                        server_name,
                        tools.len()
                    );

                    // Register the client
                    if let Ok(mut clients) = manager.clients.lock() {
                        clients.insert(server_name.clone(), Arc::new(Mutex::new(client)));
                    }

                    // Emit tools to the frontend
                    if let Err(e) = app.emit("mcp-tools-ready", &tools) {
                        log::error!("Failed to emit mcp-tools-ready for '{}': {}", server_name, e);
                    }
                }
                Err(e) => {
                    log::error!("Failed to initialize MCP server '{}': {}", server_name, e);
                }
            }
        });
    }

    Ok(())
}

#[tauri::command]
pub fn mcp_call_tool(
    server: String,
    tool: String,
    args: Value,
    manager: tauri::State<'_, Arc<McpManager>>,
) -> Result<String, String> {
    let clients = manager
        .clients
        .lock()
        .map_err(|e| format!("Lock error: {}", e))?;

    let client_arc = clients
        .get(&server)
        .ok_or_else(|| format!("MCP server '{}' not found", server))?
        .clone();

    // Drop the outer lock before locking the individual client
    drop(clients);

    let mut client = client_arc
        .lock()
        .map_err(|e| format!("Client lock error: {}", e))?;

    client.call_tool(&tool, args)
}

#[tauri::command]
pub fn mcp_shutdown(manager: tauri::State<'_, Arc<McpManager>>) -> Result<(), String> {
    let mut clients = manager
        .clients
        .lock()
        .map_err(|e| format!("Lock error: {}", e))?;

    for (name, client_arc) in clients.drain() {
        log::info!("Shutting down MCP server: {}", name);
        if let Ok(mut client) = client_arc.lock() {
            client.shutdown();
        }
    }

    manager.initialized.store(false, Ordering::SeqCst);

    Ok(())
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
        let json = r#"{"jsonrpc":"2.0","id":2,"error":{"code":-32601,"message":"Method not found"}}"#;
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
        assert_eq!(shell_escape("@modelcontextprotocol/server-filesystem"), "@modelcontextprotocol/server-filesystem");
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
        let cmd = McpClient::shell_quoted("npx", &[
            "-y".into(),
            "@modelcontextprotocol/server-filesystem".into(),
            "/tmp".into(),
        ]);
        assert_eq!(cmd, "npx -y @modelcontextprotocol/server-filesystem /tmp");
    }

    #[test]
    fn shell_quoted_escapes_spaces_in_args() {
        let cmd = McpClient::shell_quoted("node", &["my script.js".into()]);
        assert_eq!(cmd, "node 'my script.js'");
    }

    #[test]
    fn parse_sse_single_data_line() {
        let body = "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"tools\":[]}}\n\n";
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
}
