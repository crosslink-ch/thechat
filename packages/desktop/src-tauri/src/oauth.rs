use serde::Serialize;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::Mutex;
use tokio::sync::oneshot;

const CALLBACK_PORT: u16 = 19876;
const CALLBACK_TIMEOUT_SECS: u64 = 300; // 5 minutes

const HTML_SUCCESS: &str = r#"<!DOCTYPE html>
<html>
<head>
  <title>TheChat - Authorization Successful</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #1a1a2e; color: #eee; }
    .container { text-align: center; padding: 2rem; }
    h1 { color: #4ade80; margin-bottom: 1rem; }
    p { color: #aaa; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Authorization Successful</h1>
    <p>You can close this window and return to TheChat.</p>
  </div>
  <script>setTimeout(() => window.close(), 2000);</script>
</body>
</html>"#;

const HTML_ERROR: &str = r#"<!DOCTYPE html>
<html>
<head>
  <title>TheChat - Authorization Failed</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #1a1a2e; color: #eee; }
    .container { text-align: center; padding: 2rem; }
    h1 { color: #f87171; margin-bottom: 1rem; }
    p { color: #aaa; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Authorization Failed</h1>
    <p>An error occurred during authorization. Please try again.</p>
  </div>
</body>
</html>"#;

#[derive(Debug, Clone, Serialize)]
pub struct OAuthCallbackResult {
    pub code: String,
    pub state: Option<String>,
}

pub struct OAuthCallbackServer {
    /// Sender for the callback result. Set when `start` is called, consumed when result arrives.
    result_tx: Mutex<Option<oneshot::Sender<Result<OAuthCallbackResult, String>>>>,
    /// Receiver for the callback result. Set when `start` is called, consumed by `await_callback`.
    result_rx: Mutex<Option<oneshot::Receiver<Result<OAuthCallbackResult, String>>>>,
}

impl OAuthCallbackServer {
    pub fn new() -> Self {
        OAuthCallbackServer {
            result_tx: Mutex::new(None),
            result_rx: Mutex::new(None),
        }
    }
}

/// Parse query string parameters from a URL path (e.g., "/callback?code=X&state=Y").
fn parse_query_params(path: &str) -> std::collections::HashMap<String, String> {
    let base = format!("http://localhost{}", path);
    match url::Url::parse(&base) {
        Ok(url) => url.query_pairs().into_owned().collect(),
        Err(_) => std::collections::HashMap::new(),
    }
}

/// Start the OAuth callback server. Returns the port it's listening on.
/// Spawns a background thread that accepts exactly one connection, parses the
/// OAuth callback, and sends the result through a channel.
#[tauri::command]
#[tracing::instrument(skip(server))]
pub async fn mcp_oauth_start(
    server: tauri::State<'_, std::sync::Arc<OAuthCallbackServer>>,
) -> Result<u16, String> {
    // Cancel any previous pending callback
    {
        let mut tx = server.result_tx.lock().map_err(|e| e.to_string())?;
        let mut rx = server.result_rx.lock().map_err(|e| e.to_string())?;
        tx.take();
        rx.take();
    }

    let (tx, rx) = oneshot::channel();

    {
        let mut tx_slot = server.result_tx.lock().map_err(|e| e.to_string())?;
        let mut rx_slot = server.result_rx.lock().map_err(|e| e.to_string())?;
        *tx_slot = Some(tx);
        *rx_slot = Some(rx);
    }

    // Bind the listener on the main thread so we know the port immediately
    let listener = TcpListener::bind(format!("127.0.0.1:{}", CALLBACK_PORT))
        .map_err(|e| format!("Failed to bind OAuth callback server on port {}: {}", CALLBACK_PORT, e))?;

    let port = listener.local_addr().map_err(|e| e.to_string())?.port();

    // Set a timeout so the listener doesn't block forever
    listener
        .set_nonblocking(false)
        .map_err(|e| format!("Failed to set blocking mode: {}", e))?;

    let server = std::sync::Arc::clone(&server);

    std::thread::spawn(move || {
        // Set a deadline for accepting connections
        let deadline = std::time::Instant::now()
            + std::time::Duration::from_secs(CALLBACK_TIMEOUT_SECS);

        listener
            .set_nonblocking(true)
            .ok();

        loop {
            if std::time::Instant::now() > deadline {
                let tx = server.result_tx.lock().ok().and_then(|mut t| t.take());
                if let Some(tx) = tx {
                    let _ = tx.send(Err("OAuth callback timed out".into()));
                }
                return;
            }

            match listener.accept() {
                Ok((mut stream, _)) => {
                    // Read the HTTP request
                    let mut buf = [0u8; 4096];
                    let n = match stream.read(&mut buf) {
                        Ok(n) => n,
                        Err(_) => continue,
                    };
                    let request = String::from_utf8_lossy(&buf[..n]);

                    // Parse the first line: "GET /callback?code=X&state=Y HTTP/1.1"
                    let first_line = request.lines().next().unwrap_or("");
                    let path = first_line.split_whitespace().nth(1).unwrap_or("");

                    // Only handle requests to /callback
                    if !path.starts_with("/callback") {
                        let response = "HTTP/1.1 404 Not Found\r\nContent-Length: 9\r\n\r\nNot Found";
                        let _ = stream.write_all(response.as_bytes());
                        continue;
                    }

                    let params = parse_query_params(path);
                    let code = params.get("code").cloned();
                    let state = params.get("state").cloned();
                    let error = params.get("error").cloned();

                    let tx = server.result_tx.lock().ok().and_then(|mut t| t.take());

                    if let Some(error) = error {
                        let error_desc = params
                            .get("error_description")
                            .cloned()
                            .unwrap_or(error);

                        let body = HTML_ERROR;
                        let response = format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                            body.len(),
                            body
                        );
                        let _ = stream.write_all(response.as_bytes());

                        if let Some(tx) = tx {
                            let _ = tx.send(Err(error_desc));
                        }
                        return;
                    }

                    if let Some(code) = code {
                        let body = HTML_SUCCESS;
                        let response = format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                            body.len(),
                            body
                        );
                        let _ = stream.write_all(response.as_bytes());

                        if let Some(tx) = tx {
                            let _ = tx.send(Ok(OAuthCallbackResult { code, state }));
                        }
                        return;
                    }

                    // No code or error — bad request
                    let body = HTML_ERROR;
                    let response = format!(
                        "HTTP/1.1 400 Bad Request\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    );
                    let _ = stream.write_all(response.as_bytes());
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    // No connection yet, sleep briefly and retry
                    std::thread::sleep(std::time::Duration::from_millis(100));
                }
                Err(_) => {
                    // Accept error — stop
                    let tx = server.result_tx.lock().ok().and_then(|mut t| t.take());
                    if let Some(tx) = tx {
                        let _ = tx.send(Err("OAuth callback server accept error".into()));
                    }
                    return;
                }
            }
        }
    });

    tracing::info!(port = port, "OAuth callback server started");
    Ok(port)
}

/// Wait for the OAuth callback. Returns the authorization code and state.
/// This command blocks until the callback is received or times out (5 minutes).
#[tauri::command]
#[tracing::instrument(skip(server))]
pub async fn mcp_oauth_await(
    server: tauri::State<'_, std::sync::Arc<OAuthCallbackServer>>,
) -> Result<OAuthCallbackResult, String> {
    let rx = {
        let mut rx_slot = server.result_rx.lock().map_err(|e| e.to_string())?;
        rx_slot
            .take()
            .ok_or_else(|| "No OAuth callback server is running".to_string())?
    };

    match rx.await {
        Ok(Ok(result)) => {
            tracing::info!("OAuth callback received successfully");
            Ok(result)
        }
        Ok(Err(e)) => Err(e),
        Err(_) => Err("OAuth callback channel closed unexpectedly".into()),
    }
}

/// Cancel any pending OAuth callback.
#[tauri::command]
#[tracing::instrument(skip(server))]
pub async fn mcp_oauth_cancel(
    server: tauri::State<'_, std::sync::Arc<OAuthCallbackServer>>,
) -> Result<(), String> {
    let mut tx = server.result_tx.lock().map_err(|e| e.to_string())?;
    let mut rx = server.result_rx.lock().map_err(|e| e.to_string())?;
    tx.take();
    rx.take();
    tracing::info!("OAuth callback cancelled");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_query_params_basic() {
        let params = parse_query_params("/callback?code=abc123&state=xyz");
        assert_eq!(params.get("code").unwrap(), "abc123");
        assert_eq!(params.get("state").unwrap(), "xyz");
    }

    #[test]
    fn parse_query_params_no_query() {
        let params = parse_query_params("/callback");
        assert!(params.is_empty());
    }

    #[test]
    fn parse_query_params_single_param() {
        let params = parse_query_params("/callback?code=abc");
        assert_eq!(params.get("code").unwrap(), "abc");
        assert!(params.get("state").is_none());
    }

    #[test]
    fn oauth_callback_server_new() {
        let server = OAuthCallbackServer::new();
        assert!(server.result_tx.lock().unwrap().is_none());
        assert!(server.result_rx.lock().unwrap().is_none());
    }
}
