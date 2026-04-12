use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use tauri::ipc::Channel;
use tokio::sync::Mutex as AsyncMutex;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::{HeaderName, HeaderValue, StatusCode};
use tokio_tungstenite::tungstenite::protocol::Message;
use tokio_tungstenite::MaybeTlsStream;

use tokio_util::sync::CancellationToken;

use super::{StreamEvent, StreamResult, ToolCallResult, Usage};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

pub(super) type CodexWebSocket =
    tokio_tungstenite::WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

pub(super) struct CodexFuncCall {
    pub call_id: String,
    pub name: String,
    pub args: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub(super) struct CodexRequestPayload {
    pub model: String,
    pub instructions: String,
    #[serde(default)]
    pub input: Vec<Value>,
    #[serde(default)]
    pub tools: Vec<Value>,
    pub tool_choice: String,
    pub parallel_tool_calls: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<Value>,
    pub store: bool,
    pub stream: bool,
    #[serde(default)]
    pub include: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub service_tier: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt_cache_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<Value>,
}

impl CodexRequestPayload {
    pub fn same_non_input_fields(&self, other: &Self) -> bool {
        let mut lhs = self.clone();
        lhs.input.clear();
        let mut rhs = other.clone();
        rhs.input.clear();
        lhs == rhs
    }
}

#[derive(Debug, Clone)]
pub(super) struct CodexLastResponse {
    pub response_id: String,
    pub items_added: Vec<Value>,
}

// ---------------------------------------------------------------------------
// Per-conversation transport session (owns its own WebSocket)
// ---------------------------------------------------------------------------

pub(super) struct CodexTransportSession {
    websocket: Option<CodexWebSocket>,
    websocket_url: Option<String>,
    active_turn_id: Option<String>,
    pub turn_state: Option<String>,
    pub last_request: Option<CodexRequestPayload>,
    pub last_response: Option<CodexLastResponse>,
    pub http_only: bool,
    /// Last time a request was sent on this session (for idle eviction).
    pub last_used: std::time::Instant,
}

impl Default for CodexTransportSession {
    fn default() -> Self {
        Self {
            websocket: None,
            websocket_url: None,
            active_turn_id: None,
            turn_state: None,
            last_request: None,
            last_response: None,
            http_only: false,
            last_used: std::time::Instant::now(),
        }
    }
}

impl CodexTransportSession {
    pub fn reset_websocket(&mut self) {
        self.websocket = None;
        self.websocket_url = None;
    }

    fn reset_request_chain(&mut self) {
        self.last_request = None;
        self.last_response = None;
    }

    pub fn reset_turn_scope(&mut self) {
        self.reset_websocket();
        self.reset_request_chain();
        self.turn_state = None;
    }

    pub fn sync_turn_scope(&mut self, turn_id: Option<&str>) {
        if self.active_turn_id.as_deref() == turn_id {
            return;
        }

        self.reset_turn_scope();
        self.active_turn_id = turn_id.map(str::to_string);
    }

    pub fn remember_turn_state(&mut self, turn_state: Option<String>) {
        if self.turn_state.is_none() {
            self.turn_state = turn_state.filter(|value| !value.is_empty());
        }
    }

    pub fn touch(&mut self) {
        self.last_used = std::time::Instant::now();
    }
}

#[derive(Debug)]
pub(super) enum CodexWebsocketError {
    Cancelled,
    Fallback { reason: String, http_only: bool },
    Fatal(String),
}

pub(super) const RESPONSES_WEBSOCKETS_BETA_VALUE: &str = "responses_websockets=2026-02-06";
pub(super) const X_CODEX_TURN_METADATA_HEADER: &str = "x-codex-turn-metadata";
pub(super) const X_CODEX_TURN_STATE_HEADER: &str = "x-codex-turn-state";

// ---------------------------------------------------------------------------
// SSE parser
// ---------------------------------------------------------------------------

pub(super) fn parse_codex_data(
    data: &str,
    acc_text: &mut String,
    acc_reasoning: &mut String,
    usage: &mut Option<Usage>,
    response_id: &mut Option<String>,
    stop_reason: &mut String,
    func_calls: &mut HashMap<String, CodexFuncCall>,
    events: &mut Vec<StreamEvent>,
) {
    if data == "[DONE]" {
        return;
    }
    let parsed: serde_json::Value = match serde_json::from_str(data) {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!(error = %e, "skipping malformed SSE chunk: {}", &data[..data.len().min(200)]);
            return;
        }
    };

    let event_type = match parsed.get("type").and_then(|v| v.as_str()) {
        Some(t) => t,
        None => return,
    };

    match event_type {
        "response.output_text.delta" => {
            if let Some(delta) = parsed.get("delta").and_then(|v| v.as_str()) {
                acc_text.push_str(delta);
                events.push(StreamEvent::TextDelta {
                    text: delta.to_string(),
                });
            }
        }
        "response.reasoning_summary_text.delta" => {
            if let Some(delta) = parsed.get("delta").and_then(|v| v.as_str()) {
                acc_reasoning.push_str(delta);
                events.push(StreamEvent::ReasoningDelta {
                    text: delta.to_string(),
                });
            }
        }
        "response.output_item.added" => {
            if let Some(item) = parsed.get("item") {
                if item.get("type").and_then(|v| v.as_str()) == Some("function_call") {
                    let item_id = item
                        .get("id")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let call_id = item
                        .get("call_id")
                        .and_then(|v| v.as_str())
                        .unwrap_or(&item_id)
                        .to_string();
                    let name = item
                        .get("name")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();

                    func_calls.insert(
                        item_id,
                        CodexFuncCall {
                            call_id: call_id.clone(),
                            name: name.clone(),
                            args: String::new(),
                        },
                    );
                    if !name.is_empty() {
                        events.push(StreamEvent::ToolCallStart {
                            tool_call_id: call_id,
                            tool_name: name,
                        });
                    }
                }
            }
        }
        "response.function_call_arguments.delta" => {
            if let Some(item_id) = parsed.get("item_id").and_then(|v| v.as_str()) {
                if let Some(delta) = parsed.get("delta").and_then(|v| v.as_str()) {
                    if let Some(fc) = func_calls.get_mut(item_id) {
                        fc.args.push_str(delta);
                        events.push(StreamEvent::ToolCallArgsDelta {
                            tool_call_id: fc.call_id.clone(),
                            args: delta.to_string(),
                        });
                    }
                }
            }
        }
        "response.output_item.done" => {
            if let Some(item) = parsed.get("item") {
                if item.get("type").and_then(|v| v.as_str()) == Some("function_call") {
                    let item_id = item.get("id").and_then(|v| v.as_str()).unwrap_or("");
                    if let Some(fc) = func_calls.get_mut(item_id) {
                        if let Some(args) = item.get("arguments").and_then(|v| v.as_str()) {
                            fc.args = args.to_string();
                        }
                    }
                }
            }
        }
        "response.completed" | "response.incomplete" => {
            *stop_reason = if event_type == "response.incomplete" {
                "length".to_string()
            } else {
                "stop".to_string()
            };
            if let Some(resp) = parsed.get("response") {
                if event_type == "response.completed" {
                    if let Some(id) = resp.get("id").and_then(|v| v.as_str()) {
                        *response_id = Some(id.to_string());
                    }
                }
                if let Some(u) = resp.get("usage") {
                    let input = u.get("input_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
                    let output = u.get("output_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
                    *usage = Some(Usage {
                        prompt_tokens: input,
                        completion_tokens: output,
                        total_tokens: input + output,
                    });
                }
            }
        }
        "error" => {
            let msg = parsed
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or("Unknown Codex API error");
            events.push(StreamEvent::Error {
                error: msg.to_string(),
            });
        }
        "codex.rate_limits" => {
            if let Some(rl) = parsed.get("rate_limits") {
                let allowed = rl.get("allowed").and_then(|v| v.as_bool()).unwrap_or(true);
                let limit_reached = rl
                    .get("limit_reached")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);

                if !allowed || limit_reached {
                    // Find the limit that was hit and its reset time
                    let reset_msg = ["primary", "secondary"]
                        .iter()
                        .filter_map(|key| {
                            let bucket = rl.get(key)?;
                            let used = bucket.get("used_percent").and_then(|v| v.as_u64())?;
                            if used >= 100 {
                                let reset_secs = bucket
                                    .get("reset_after_seconds")
                                    .and_then(|v| v.as_u64())
                                    .unwrap_or(0);
                                let mins = reset_secs / 60;
                                let hours = mins / 60;
                                let remaining_mins = mins % 60;
                                let time_str = if hours > 0 {
                                    format!("{}h {}m", hours, remaining_mins)
                                } else {
                                    format!("{}m", mins)
                                };
                                Some(format!(
                                    "Codex rate limit reached ({}). Resets in {}.",
                                    key, time_str
                                ))
                            } else {
                                None
                            }
                        })
                        .next()
                        .unwrap_or_else(|| "Codex rate limit reached.".to_string());

                    events.push(StreamEvent::Error { error: reset_msg });
                }
            }
        }
        _ => {} // Ignore unknown event types
    }
}

pub(super) fn finalize_codex_tools(
    func_calls: HashMap<String, CodexFuncCall>,
    events: &mut Vec<StreamEvent>,
) -> Vec<ToolCallResult> {
    func_calls
        .into_values()
        .map(|fc| {
            let parsed_args: serde_json::Value = serde_json::from_str(&fc.args)
                .unwrap_or_else(|_| {
                    tracing::warn!(tool = %fc.name, "failed to parse tool args: {}", &fc.args[..fc.args.len().min(200)]);
                    serde_json::Value::Object(serde_json::Map::new())
                });
            events.push(StreamEvent::ToolCallComplete {
                tool_call_id: fc.call_id.clone(),
                tool_name: fc.name.clone(),
                args: parsed_args.clone(),
            });
            ToolCallResult {
                id: fc.call_id,
                name: fc.name,
                args: parsed_args,
            }
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Header helpers
// ---------------------------------------------------------------------------

pub(super) fn codex_session_key(headers: &HashMap<String, String>) -> Option<String> {
    headers
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case("session_id"))
        .map(|(_, value)| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

pub(super) fn codex_turn_id(headers: &HashMap<String, String>) -> Option<String> {
    headers
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case(X_CODEX_TURN_METADATA_HEADER))
        .and_then(|(_, value)| serde_json::from_str::<Value>(value).ok())
        .and_then(|metadata| {
            metadata
                .get("turn_id")
                .and_then(|value| value.as_str())
                .map(str::to_string)
        })
        .filter(|value| !value.is_empty())
}

pub(super) fn parse_codex_request_payload(body: &str) -> Result<CodexRequestPayload, String> {
    serde_json::from_str(body).map_err(|e| format!("invalid Codex request JSON: {}", e))
}

// ---------------------------------------------------------------------------
// WebSocket transport internals
// ---------------------------------------------------------------------------

fn build_codex_ws_request_body(
    request: &CodexRequestPayload,
    previous_response_id: Option<&str>,
    input_override: Option<Vec<Value>>,
) -> Result<String, String> {
    let mut payload = serde_json::to_value(request)
        .map_err(|e| format!("failed to encode Codex websocket request: {}", e))?;
    let object = payload
        .as_object_mut()
        .ok_or_else(|| "Codex request body must be a JSON object".to_string())?;

    if let Some(previous_response_id) = previous_response_id {
        object.insert(
            "previous_response_id".to_string(),
            Value::String(previous_response_id.to_string()),
        );
    }
    if let Some(input) = input_override {
        object.insert("input".to_string(), Value::Array(input));
    }
    object.insert(
        "type".to_string(),
        Value::String("response.create".to_string()),
    );

    serde_json::to_string(&payload)
        .map_err(|e| format!("failed to encode Codex websocket request: {}", e))
}

fn codex_incremental_input(
    current: &CodexRequestPayload,
    previous_request: &CodexRequestPayload,
    previous_response: &CodexLastResponse,
) -> Option<Vec<Value>> {
    if !previous_request.same_non_input_fields(current) {
        return None;
    }

    let mut baseline = previous_request.input.clone();
    baseline.extend(previous_response.items_added.clone());

    if current.input.starts_with(&baseline) {
        Some(current.input[baseline.len()..].to_vec())
    } else {
        None
    }
}

fn codex_items_added_from_result(result: &StreamResult) -> Vec<Value> {
    let mut items = Vec::new();

    if !result.text.is_empty() {
        items.push(json!({
            "type": "message",
            "role": "assistant",
            "content": [
                {
                    "type": "output_text",
                    "text": result.text,
                }
            ],
        }));
    }

    for tool_call in &result.tool_calls {
        items.push(json!({
            "type": "function_call",
            "id": tool_call.id,
            "call_id": tool_call.id,
            "name": tool_call.name,
            "arguments": serde_json::to_string(&tool_call.args).unwrap_or_else(|_| "{}".to_string()),
        }));
    }

    items
}

pub(super) async fn update_codex_transport_session(
    session: Option<&Arc<AsyncMutex<CodexTransportSession>>>,
    websocket_url: Option<&str>,
    request: &CodexRequestPayload,
    response_id: Option<String>,
    result: &StreamResult,
) {
    let Some(session) = session else {
        return;
    };

    let mut session = session.lock().await;
    if let Some(websocket_url) = websocket_url {
        session.websocket_url = Some(websocket_url.to_string());
    }
    session.last_request = Some(request.clone());
    session.last_response = response_id
        .filter(|response_id| !response_id.is_empty())
        .map(|response_id| CodexLastResponse {
            response_id,
            items_added: codex_items_added_from_result(result),
        });
}

fn codex_ws_url_from_api_url(url: &str) -> Result<String, String> {
    let mut parsed = reqwest::Url::parse(url)
        .map_err(|e| format!("invalid Codex API URL for websocket transport: {}", e))?;

    match parsed.scheme() {
        "https" => parsed
            .set_scheme("wss")
            .map_err(|_| "failed to switch Codex transport to wss".to_string())?,
        "http" => parsed
            .set_scheme("ws")
            .map_err(|_| "failed to switch Codex transport to ws".to_string())?,
        "wss" | "ws" => {}
        scheme => {
            return Err(format!(
                "unsupported URL scheme for Codex websocket transport: {}",
                scheme
            ));
        }
    }

    Ok(parsed.to_string())
}

fn apply_codex_ws_headers(
    request: &mut tokio_tungstenite::tungstenite::http::Request<()>,
    headers: &HashMap<String, String>,
    turn_state: Option<&str>,
) {
    for (name, value) in headers {
        if name.eq_ignore_ascii_case("content-type") || name.eq_ignore_ascii_case("accept") {
            continue;
        }

        let Ok(header_name) = name.parse::<HeaderName>() else {
            continue;
        };
        let Ok(header_value) = HeaderValue::from_str(value) else {
            continue;
        };
        request.headers_mut().insert(header_name, header_value);
    }

    if let Some(turn_state) = turn_state {
        if let Ok(header_value) = HeaderValue::from_str(turn_state) {
            request
                .headers_mut()
                .insert(HeaderName::from_static("x-codex-turn-state"), header_value);
        }
    }

    request.headers_mut().insert(
        HeaderName::from_static("openai-beta"),
        HeaderValue::from_static(RESPONSES_WEBSOCKETS_BETA_VALUE),
    );
}

fn is_codex_terminal_event(data: &str) -> bool {
    serde_json::from_str::<Value>(data)
        .ok()
        .and_then(|parsed| {
            parsed
                .get("type")
                .and_then(|v| v.as_str())
                .map(str::to_string)
        })
        .is_some_and(|event_type| {
            matches!(
                event_type.as_str(),
                "response.completed" | "response.incomplete"
            )
        })
}

async fn connect_codex_websocket(
    ws_url: &str,
    headers: &HashMap<String, String>,
    turn_state: Option<&str>,
) -> Result<(CodexWebSocket, Option<String>), CodexWebsocketError> {
    let mut request = ws_url
        .into_client_request()
        .map_err(|e| CodexWebsocketError::Fallback {
            reason: format!("failed to build websocket request: {}", e),
            http_only: false,
        })?;
    apply_codex_ws_headers(&mut request, headers, turn_state);

    let (socket, response) = connect_async(request).await.map_err(|e| match e {
        tokio_tungstenite::tungstenite::Error::Http(response)
            if response.status() == StatusCode::UPGRADE_REQUIRED =>
        {
            CodexWebsocketError::Fallback {
                reason: "Codex websocket transport is not supported by this endpoint".to_string(),
                http_only: true,
            }
        }
        other => CodexWebsocketError::Fallback {
            reason: format!("Codex websocket connect failed: {}", other),
            http_only: false,
        },
    })?;

    let turn_state = response
        .headers()
        .get(X_CODEX_TURN_STATE_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);

    Ok((socket, turn_state))
}

async fn read_codex_websocket_response(
    socket: &mut CodexWebSocket,
    cancel: &CancellationToken,
    on_event: &Channel<Vec<StreamEvent>>,
) -> Result<(StreamResult, Option<String>), CodexWebsocketError> {
    let mut acc_text = String::new();
    let mut acc_reasoning = String::new();
    let mut usage: Option<Usage> = None;
    let mut response_id = None;
    let mut stop_reason = String::from("unknown");
    let mut codex_func_calls: HashMap<String, CodexFuncCall> = HashMap::new();
    let mut event_batch: Vec<StreamEvent> = Vec::new();
    let mut last_flush = std::time::Instant::now();
    let mut saw_terminal = false;
    let mut received_payload = false;

    loop {
        let message = tokio::select! {
            msg = socket.next() => match msg {
                Some(Ok(message)) => message,
                Some(Err(err)) => {
                    return Err(CodexWebsocketError::Fatal(format!(
                        "Codex websocket read error: {}",
                        err
                    )));
                }
                None => break,
            },
            _ = cancel.cancelled() => {
                let _ = socket.close(None).await;
                return Err(CodexWebsocketError::Cancelled);
            }
        };

        match message {
            Message::Text(text) => {
                let payload = text.to_string();
                received_payload = true;
                let mut line_events = Vec::new();
                parse_codex_data(
                    &payload,
                    &mut acc_text,
                    &mut acc_reasoning,
                    &mut usage,
                    &mut response_id,
                    &mut stop_reason,
                    &mut codex_func_calls,
                    &mut line_events,
                );
                if is_codex_terminal_event(&payload) {
                    saw_terminal = true;
                }

                let has_structural = line_events.iter().any(|e| {
                    matches!(
                        e,
                        StreamEvent::ToolCallStart { .. }
                            | StreamEvent::ToolCallComplete { .. }
                            | StreamEvent::Error { .. }
                    )
                });

                event_batch.extend(line_events);
                if has_structural || last_flush.elapsed() >= std::time::Duration::from_millis(16) {
                    if !event_batch.is_empty() {
                        let batch = std::mem::take(&mut event_batch);
                        let _ = on_event.send(batch);
                        last_flush = std::time::Instant::now();
                    }
                }

                // Terminal event means the response is complete — break out
                // immediately so we don't block on the persistent WebSocket
                // waiting for a message that will never come.
                if saw_terminal {
                    break;
                }
            }
            Message::Binary(data) => {
                let payload = String::from_utf8(data.to_vec()).map_err(|_| {
                    CodexWebsocketError::Fatal(
                        "unexpected binary Codex websocket event".to_string(),
                    )
                })?;
                received_payload = true;
                let mut line_events = Vec::new();
                parse_codex_data(
                    &payload,
                    &mut acc_text,
                    &mut acc_reasoning,
                    &mut usage,
                    &mut response_id,
                    &mut stop_reason,
                    &mut codex_func_calls,
                    &mut line_events,
                );
                if is_codex_terminal_event(&payload) {
                    saw_terminal = true;
                }

                let has_structural = line_events.iter().any(|e| {
                    matches!(
                        e,
                        StreamEvent::ToolCallStart { .. }
                            | StreamEvent::ToolCallComplete { .. }
                            | StreamEvent::Error { .. }
                    )
                });

                event_batch.extend(line_events);
                if has_structural || last_flush.elapsed() >= std::time::Duration::from_millis(16) {
                    if !event_batch.is_empty() {
                        let batch = std::mem::take(&mut event_batch);
                        let _ = on_event.send(batch);
                        last_flush = std::time::Instant::now();
                    }
                }

                if saw_terminal {
                    break;
                }
            }
            Message::Ping(payload) => {
                socket.send(Message::Pong(payload)).await.map_err(|e| {
                    CodexWebsocketError::Fatal(format!("Codex websocket pong failed: {}", e))
                })?;
            }
            Message::Pong(_) => {}
            Message::Close(_) => break,
            _ => {}
        }
    }

    if !event_batch.is_empty() {
        let batch = std::mem::take(&mut event_batch);
        let _ = on_event.send(batch);
    }

    let mut final_events = Vec::new();
    let tool_calls = finalize_codex_tools(codex_func_calls, &mut final_events);
    if !final_events.is_empty() {
        let _ = on_event.send(final_events);
    }

    if !saw_terminal {
        if !received_payload {
            return Err(CodexWebsocketError::Fallback {
                reason: "Codex websocket closed before streaming any events".to_string(),
                http_only: false,
            });
        }
        return Err(CodexWebsocketError::Fatal(
            "Codex websocket closed before response.completed".to_string(),
        ));
    }

    Ok((
        StreamResult {
            text: acc_text,
            reasoning: acc_reasoning,
            tool_calls,
            usage,
            stop_reason,
        },
        response_id,
    ))
}

// ---------------------------------------------------------------------------
// Public WebSocket stream entry point
// ---------------------------------------------------------------------------

pub(super) async fn try_codex_websocket_stream(
    url: String,
    headers: HashMap<String, String>,
    request: CodexRequestPayload,
    session: Option<Arc<AsyncMutex<CodexTransportSession>>>,
    cancel: CancellationToken,
    on_event: &Channel<Vec<StreamEvent>>,
) -> Result<StreamResult, CodexWebsocketError> {
    let ws_url =
        codex_ws_url_from_api_url(&url).map_err(|reason| CodexWebsocketError::Fallback {
            reason,
            http_only: false,
        })?;

    if let Some(session) = session {
        let mut session = session.lock().await;
        if session.http_only {
            return Err(CodexWebsocketError::Fallback {
                reason: "Codex websocket transport disabled for this conversation".to_string(),
                http_only: true,
            });
        }

        session.touch();

        if session.websocket_url.as_deref() != Some(ws_url.as_str()) {
            session.reset_turn_scope();
            session.websocket_url = Some(ws_url.clone());
        }

        let mut previous_response_id = None;
        let mut input_override = None;
        if let (Some(previous_request), Some(previous_response)) = (
            session.last_request.as_ref(),
            session.last_response.as_ref(),
        ) {
            if let Some(incremental_input) =
                codex_incremental_input(&request, previous_request, previous_response)
            {
                previous_response_id = Some(previous_response.response_id.as_str());
                input_override = Some(incremental_input);
            }
        }

        let ws_body = build_codex_ws_request_body(&request, previous_response_id, input_override)
            .map_err(CodexWebsocketError::Fatal)?;

        if session.websocket.is_none() {
            let (socket, turn_state) =
                connect_codex_websocket(&ws_url, &headers, session.turn_state.as_deref()).await?;
            session.remember_turn_state(turn_state);
            session.websocket = Some(socket);
        }

        let socket = session.websocket.as_mut().expect("websocket missing");
        if let Err(err) = socket.send(Message::Text(ws_body.into())).await {
            session.reset_websocket();
            return Err(CodexWebsocketError::Fallback {
                reason: format!("Codex websocket send failed: {}", err),
                http_only: false,
            });
        }

        match read_codex_websocket_response(socket, &cancel, on_event).await {
            Ok((result, response_id)) => {
                session.last_request = Some(request);
                session.last_response = response_id
                    .filter(|response_id| !response_id.is_empty())
                    .map(|response_id| CodexLastResponse {
                        response_id,
                        items_added: codex_items_added_from_result(&result),
                    });
                Ok(result)
            }
            Err(CodexWebsocketError::Cancelled) => {
                session.reset_websocket();
                Err(CodexWebsocketError::Cancelled)
            }
            Err(CodexWebsocketError::Fallback { reason, http_only }) => {
                session.reset_websocket();
                if http_only {
                    session.http_only = true;
                }
                Err(CodexWebsocketError::Fallback { reason, http_only })
            }
            Err(CodexWebsocketError::Fatal(reason)) => {
                session.reset_websocket();
                Err(CodexWebsocketError::Fatal(reason))
            }
        }
    } else {
        let ws_body = build_codex_ws_request_body(&request, None, None)
            .map_err(CodexWebsocketError::Fatal)?;
        let (mut socket, _) = connect_codex_websocket(&ws_url, &headers, None).await?;
        socket
            .send(Message::Text(ws_body.into()))
            .await
            .map_err(|e| CodexWebsocketError::Fallback {
                reason: format!("Codex websocket send failed: {}", e),
                http_only: false,
            })?;
        let (result, _) =
            read_codex_websocket_response(&mut socket, &cancel, on_event).await?;
        Ok(result)
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_cx(
        data: &str,
    ) -> (
        String,
        String,
        Option<Usage>,
        HashMap<String, CodexFuncCall>,
        Vec<StreamEvent>,
    ) {
        let mut text = String::new();
        let mut reasoning = String::new();
        let mut usage = None;
        let mut response_id = None;
        let mut stop_reason = String::from("unknown");
        let mut func_calls = HashMap::new();
        let mut events = Vec::new();
        parse_codex_data(
            data,
            &mut text,
            &mut reasoning,
            &mut usage,
            &mut response_id,
            &mut stop_reason,
            &mut func_calls,
            &mut events,
        );
        (text, reasoning, usage, func_calls, events)
    }

    #[test]
    fn codex_ws_url_rewrites_http_schemes() {
        assert_eq!(
            codex_ws_url_from_api_url("https://chatgpt.com/backend-api/codex/responses")
                .expect("wss url"),
            "wss://chatgpt.com/backend-api/codex/responses"
        );
        assert_eq!(
            codex_ws_url_from_api_url("http://localhost:8080/v1/responses").expect("ws url"),
            "ws://localhost:8080/v1/responses"
        );
    }

    #[test]
    fn build_codex_ws_request_body_wraps_response_create() {
        let request = parse_codex_request_payload(
            r#"{"model":"gpt-5.4","instructions":"","stream":true,"store":false,"tool_choice":"auto","parallel_tool_calls":true,"input":[{"type":"message"}],"include":[]}"#,
        )
        .expect("request payload");
        let body = build_codex_ws_request_body(
            &request,
            Some("resp_123"),
            Some(vec![json!({"type":"message","role":"user"})]),
        )
        .expect("wrapped request");
        let value: Value = serde_json::from_str(&body).expect("json body");
        assert_eq!(value["type"], Value::String("response.create".into()));
        assert_eq!(value["model"], Value::String("gpt-5.4".into()));
        assert_eq!(value["stream"], Value::Bool(true));
        assert_eq!(
            value["previous_response_id"],
            Value::String("resp_123".into())
        );
        assert_eq!(value["input"][0]["role"], Value::String("user".into()));
    }

    #[test]
    fn codex_incremental_input_uses_previous_response_prefix() {
        let previous_request = parse_codex_request_payload(
            r#"{
                "model":"gpt-5.4",
                "instructions":"system",
                "tool_choice":"auto",
                "parallel_tool_calls":true,
                "stream":true,
                "store":false,
                "include":["reasoning.encrypted_content"],
                "input":[
                    {"type":"message","role":"user","content":[{"type":"input_text","text":"hello"}]}
                ]
            }"#,
        )
        .expect("previous request");
        let current_request = parse_codex_request_payload(
            r#"{
                "model":"gpt-5.4",
                "instructions":"system",
                "tool_choice":"auto",
                "parallel_tool_calls":true,
                "stream":true,
                "store":false,
                "include":["reasoning.encrypted_content"],
                "input":[
                    {"type":"message","role":"user","content":[{"type":"input_text","text":"hello"}]},
                    {"type":"message","role":"assistant","content":[{"type":"output_text","text":"I will read that file."}]},
                    {"type":"function_call","id":"fc_1","call_id":"fc_1","name":"read_file","arguments":"{\"path\":\"foo.txt\"}"},
                    {"type":"function_call_output","call_id":"fc_1","output":"{\"content\":\"ok\"}"}
                ]
            }"#,
        )
        .expect("current request");
        let previous_response = CodexLastResponse {
            response_id: "resp_1".to_string(),
            items_added: vec![
                json!({
                    "type": "message",
                    "role": "assistant",
                    "content": [{"type": "output_text", "text": "I will read that file."}],
                }),
                json!({
                    "type": "function_call",
                    "id": "fc_1",
                    "call_id": "fc_1",
                    "name": "read_file",
                    "arguments": "{\"path\":\"foo.txt\"}",
                }),
            ],
        };

        let incremental =
            codex_incremental_input(&current_request, &previous_request, &previous_response)
                .expect("incremental input");
        assert_eq!(
            incremental,
            vec![json!({
                "type": "function_call_output",
                "call_id": "fc_1",
                "output": "{\"content\":\"ok\"}",
            })]
        );
    }

    #[test]
    fn codex_incremental_input_requires_matching_non_input_fields() {
        let previous_request = parse_codex_request_payload(
            r#"{
                "model":"gpt-5.4",
                "instructions":"system one",
                "tool_choice":"auto",
                "parallel_tool_calls":true,
                "stream":true,
                "store":false,
                "include":[],
                "input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"hello"}]}]
            }"#,
        )
        .expect("previous request");
        let current_request = parse_codex_request_payload(
            r#"{
                "model":"gpt-5.4",
                "instructions":"system two",
                "tool_choice":"auto",
                "parallel_tool_calls":true,
                "stream":true,
                "store":false,
                "include":[],
                "input":[
                    {"type":"message","role":"user","content":[{"type":"input_text","text":"hello"}]},
                    {"type":"message","role":"user","content":[{"type":"input_text","text":"second"}]}
                ]
            }"#,
        )
        .expect("current request");
        let previous_response = CodexLastResponse {
            response_id: "resp_1".to_string(),
            items_added: Vec::new(),
        };

        assert_eq!(
            codex_incremental_input(&current_request, &previous_request, &previous_response),
            None
        );
    }

    #[test]
    fn codex_turn_id_reads_turn_metadata_header() {
        let headers = HashMap::from([(
            "x-codex-turn-metadata".to_string(),
            r#"{"turn_id":"turn_123"}"#.to_string(),
        )]);

        assert_eq!(codex_turn_id(&headers).as_deref(), Some("turn_123"));
    }

    #[test]
    fn codex_transport_session_resets_turn_scope_on_turn_change() {
        let request = parse_codex_request_payload(
            r#"{
                "model":"gpt-5.4",
                "instructions":"system",
                "tool_choice":"auto",
                "parallel_tool_calls":true,
                "stream":true,
                "store":false,
                "include":[],
                "input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"hello"}]}]
            }"#,
        )
        .expect("request payload");

        let mut session = CodexTransportSession {
            websocket_url: Some("wss://chatgpt.com/backend-api/codex/responses".to_string()),
            active_turn_id: Some("turn_1".to_string()),
            turn_state: Some("ts_1".to_string()),
            last_request: Some(request),
            last_response: Some(CodexLastResponse {
                response_id: "resp_1".to_string(),
                items_added: vec![json!({"type":"message"})],
            }),
            ..Default::default()
        };

        session.sync_turn_scope(Some("turn_2"));

        assert_eq!(session.active_turn_id.as_deref(), Some("turn_2"));
        assert_eq!(session.turn_state, None);
        assert_eq!(session.websocket_url, None);
        assert!(session.last_request.is_none());
        assert!(session.last_response.is_none());
    }

    #[test]
    fn apply_codex_ws_headers_includes_turn_state() {
        let mut request = "wss://chatgpt.com/backend-api/codex/responses"
            .into_client_request()
            .expect("request");
        let headers = HashMap::from([("authorization".to_string(), "Bearer test".to_string())]);

        apply_codex_ws_headers(&mut request, &headers, Some("ts_1"));

        assert_eq!(
            request
                .headers()
                .get(X_CODEX_TURN_STATE_HEADER)
                .and_then(|value| value.to_str().ok()),
            Some("ts_1")
        );
        assert_eq!(
            request
                .headers()
                .get("authorization")
                .and_then(|value| value.to_str().ok()),
            Some("Bearer test")
        );
    }

    #[test]
    fn parse_codex_completed_captures_response_id() {
        let mut text = String::new();
        let mut reasoning = String::new();
        let mut usage = None;
        let mut response_id = None;
        let mut stop_reason = String::from("unknown");
        let mut func_calls = HashMap::new();
        let mut events = Vec::new();

        parse_codex_data(
            r#"{"type":"response.completed","response":{"id":"resp_done","usage":{"input_tokens":3,"output_tokens":5}}}"#,
            &mut text,
            &mut reasoning,
            &mut usage,
            &mut response_id,
            &mut stop_reason,
            &mut func_calls,
            &mut events,
        );

        assert_eq!(response_id.as_deref(), Some("resp_done"));
        assert_eq!(stop_reason, "stop");
        assert_eq!(usage.expect("usage").total_tokens, 8);
    }

    #[test]
    fn test_parse_codex_text_delta() {
        let (text, _, _, _, events) =
            parse_cx(r#"{"type":"response.output_text.delta","delta":"Hello"}"#);
        assert_eq!(text, "Hello");
        assert_eq!(events.len(), 1);
        assert_eq!(
            events[0],
            StreamEvent::TextDelta {
                text: "Hello".into()
            }
        );
    }

    #[test]
    fn test_parse_codex_function_call_flow() {
        let mut text = String::new();
        let mut reasoning = String::new();
        let mut usage = None;
        let mut response_id = None;
        let mut stop_reason = String::from("unknown");
        let mut func_calls: HashMap<String, CodexFuncCall> = HashMap::new();
        let mut events = Vec::new();

        // 1. Item added
        parse_codex_data(
            r#"{"type":"response.output_item.added","item":{"type":"function_call","id":"fc_1","call_id":"fc_1","name":"read"}}"#,
            &mut text,
            &mut reasoning,
            &mut usage,
            &mut response_id,
            &mut stop_reason,
            &mut func_calls,
            &mut events,
        );
        // 2. Args delta
        parse_codex_data(
            r#"{"type":"response.function_call_arguments.delta","item_id":"fc_1","delta":"{\"path\":"}"#,
            &mut text,
            &mut reasoning,
            &mut usage,
            &mut response_id,
            &mut stop_reason,
            &mut func_calls,
            &mut events,
        );
        // 3. More args
        parse_codex_data(
            r#"{"type":"response.function_call_arguments.delta","item_id":"fc_1","delta":"\"foo\"}"}"#,
            &mut text,
            &mut reasoning,
            &mut usage,
            &mut response_id,
            &mut stop_reason,
            &mut func_calls,
            &mut events,
        );
        // 4. Item done (with final arguments)
        parse_codex_data(
            r#"{"type":"response.output_item.done","item":{"type":"function_call","id":"fc_1","arguments":"{\"path\":\"foo\"}"}}"#,
            &mut text,
            &mut reasoning,
            &mut usage,
            &mut response_id,
            &mut stop_reason,
            &mut func_calls,
            &mut events,
        );

        assert_eq!(func_calls.len(), 1);
        let fc = func_calls.get("fc_1").unwrap();
        assert_eq!(fc.name, "read");
        assert_eq!(fc.args, r#"{"path":"foo"}"#);

        assert!(events
            .iter()
            .any(|e| matches!(e, StreamEvent::ToolCallStart { .. })));
    }

    #[test]
    fn test_parse_codex_usage() {
        let (_, _, usage, _, _) = parse_cx(
            r#"{"type":"response.completed","response":{"usage":{"input_tokens":100,"output_tokens":50}}}"#,
        );
        let u = usage.unwrap();
        assert_eq!(u.prompt_tokens, 100);
        assert_eq!(u.completion_tokens, 50);
        assert_eq!(u.total_tokens, 150);
    }

    #[test]
    fn test_finalize_codex_tools_emits_complete() {
        let mut func_calls = HashMap::new();
        func_calls.insert(
            "fc_1".into(),
            CodexFuncCall {
                call_id: "fc_1".into(),
                name: "read".into(),
                args: r#"{"path":"bar"}"#.into(),
            },
        );
        let mut events = Vec::new();
        let results = finalize_codex_tools(func_calls, &mut events);

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].id, "fc_1");
        assert_eq!(results[0].name, "read");
        assert_eq!(results[0].args, serde_json::json!({"path": "bar"}));

        assert_eq!(events.len(), 1);
        assert!(matches!(&events[0], StreamEvent::ToolCallComplete { .. }));
    }

    #[test]
    fn test_codex_error_event() {
        let (_, _, _, _, events) = parse_cx(r#"{"type":"error","message":"Rate limit exceeded"}"#);
        assert_eq!(events.len(), 1);
        assert_eq!(
            events[0],
            StreamEvent::Error {
                error: "Rate limit exceeded".into()
            }
        );
    }

    #[test]
    fn test_codex_reasoning_delta() {
        let (_, reasoning, _, _, events) =
            parse_cx(r#"{"type":"response.reasoning_summary_text.delta","delta":"Thinking..."}"#);
        assert_eq!(reasoning, "Thinking...");
        assert_eq!(
            events[0],
            StreamEvent::ReasoningDelta {
                text: "Thinking...".into()
            }
        );
    }

    #[test]
    fn test_codex_rate_limit_reached_emits_error() {
        let (_, _, _, _, events) = parse_cx(
            r#"{"type":"codex.rate_limits","plan_type":"plus","rate_limits":{"allowed":false,"limit_reached":true,"primary":{"used_percent":100,"window_minutes":300,"reset_after_seconds":5400,"reset_at":1773878280},"secondary":{"used_percent":35,"window_minutes":10080,"reset_after_seconds":414762,"reset_at":1774283606}}}"#,
        );
        assert_eq!(events.len(), 1);
        match &events[0] {
            StreamEvent::Error { error } => {
                assert!(error.contains("rate limit reached"), "got: {}", error);
                assert!(error.contains("primary"), "got: {}", error);
                assert!(error.contains("1h 30m"), "got: {}", error);
            }
            other => panic!("expected Error event, got: {:?}", other),
        }
    }

    #[test]
    fn test_codex_rate_limit_not_reached_no_event() {
        let (_, _, _, _, events) = parse_cx(
            r#"{"type":"codex.rate_limits","plan_type":"plus","rate_limits":{"allowed":true,"limit_reached":false,"primary":{"used_percent":10,"window_minutes":300,"reset_after_seconds":9437,"reset_at":1773878280},"secondary":{"used_percent":35,"window_minutes":10080,"reset_after_seconds":414762,"reset_at":1774283606}}}"#,
        );
        assert!(events.is_empty(), "expected no events when not rate limited");
    }

    // -----------------------------------------------------------------------
    // Live test helpers
    // -----------------------------------------------------------------------

    const CODEX_API_URL: &str = "https://chatgpt.com/backend-api/codex/responses";

    fn live_headers() -> HashMap<String, String> {
        let access_token =
            std::env::var("CODEX_ACCESS_TOKEN").expect("CODEX_ACCESS_TOKEN env var required");
        let account_id = std::env::var("CODEX_ACCOUNT_ID").unwrap_or_default();
        let mut headers = HashMap::new();
        headers.insert(
            "Authorization".to_string(),
            format!("Bearer {}", access_token),
        );
        if !account_id.is_empty() {
            headers.insert("ChatGPT-Account-Id".to_string(), account_id);
        }
        headers
    }

    fn make_request(input: Vec<Value>, tools: Vec<Value>) -> CodexRequestPayload {
        parse_codex_request_payload(
            &serde_json::json!({
                "model": "gpt-5.3-codex",
                "instructions": "You are a helpful assistant. Keep your response very short.",
                "reasoning": { "effort": "low" },
                "input": input,
                "tools": tools,
                "tool_choice": "auto",
                "parallel_tool_calls": true,
                "stream": true,
                "store": false,
                "include": [],
            })
            .to_string(),
        )
        .expect("request payload")
    }

    fn user_message(text: &str) -> Value {
        json!({
            "type": "message",
            "role": "user",
            "content": [{ "type": "input_text", "text": text }],
        })
    }

    fn tool_output(call_id: &str, output: &str) -> Value {
        json!({
            "type": "function_call_output",
            "call_id": call_id,
            "output": output,
        })
    }

    /// Read a full response from a Codex WebSocket, parsing with our real parser.
    /// Returns (StreamResult, response_id) — mirrors read_codex_websocket_response
    /// but without needing a Tauri Channel.
    async fn read_ws_response(
        socket: &mut CodexWebSocket,
    ) -> (super::StreamResult, Option<String>) {
        let mut acc_text = String::new();
        let mut acc_reasoning = String::new();
        let mut usage = None;
        let mut response_id = None;
        let mut stop_reason = String::from("unknown");
        let mut func_calls: HashMap<String, CodexFuncCall> = HashMap::new();

        loop {
            let message = socket
                .next()
                .await
                .expect("WebSocket stream ended before terminal event")
                .expect("WebSocket read error");

            let payload = match message {
                Message::Text(text) => text.to_string(),
                Message::Binary(data) => {
                    String::from_utf8(data.to_vec()).expect("invalid UTF-8 in binary frame")
                }
                Message::Ping(_) | Message::Pong(_) => continue,
                Message::Close(_) => panic!("WebSocket closed before terminal event"),
                _ => continue,
            };

            let mut events = Vec::new();
            parse_codex_data(
                &payload,
                &mut acc_text,
                &mut acc_reasoning,
                &mut usage,
                &mut response_id,
                &mut stop_reason,
                &mut func_calls,
                &mut events,
            );

            if is_codex_terminal_event(&payload) {
                break;
            }
        }

        let mut final_events = Vec::new();
        let tool_calls = finalize_codex_tools(func_calls, &mut final_events);

        (
            super::StreamResult {
                text: acc_text,
                reasoning: acc_reasoning,
                tool_calls,
                usage,
                stop_reason,
            },
            response_id,
        )
    }

    async fn send_ws_request(
        socket: &mut CodexWebSocket,
        request: &CodexRequestPayload,
        previous_response_id: Option<&str>,
        input_override: Option<Vec<Value>>,
    ) {
        let ws_body =
            build_codex_ws_request_body(request, previous_response_id, input_override)
                .expect("build ws request body");
        socket
            .send(Message::Text(ws_body.into()))
            .await
            .expect("WebSocket send failed");
    }

    // -----------------------------------------------------------------------
    // Live tests — require CODEX_ACCESS_TOKEN, run via `python3 scripts/test.py codex`
    // -----------------------------------------------------------------------

    /// HTTP SSE: basic text response.
    #[tokio::test]
    #[ignore]
    async fn codex_live_http_hello_world() {
        let headers = live_headers();
        let request = make_request(vec![user_message("Say hello world")], vec![]);

        let client = reqwest::Client::new();
        let mut req = client
            .post(CODEX_API_URL)
            .header("Content-Type", "application/json")
            .header("Accept", "text/event-stream");

        for (k, v) in &headers {
            req = req.header(k, v);
        }

        let response = req
            .body(serde_json::to_string(&request).expect("serialize"))
            .send()
            .await
            .expect("HTTP request failed");
        assert!(
            response.status().is_success(),
            "Codex API returned {}",
            response.status()
        );

        let mut acc_text = String::new();
        let mut acc_reasoning = String::new();
        let mut usage = None;
        let mut response_id = None;
        let mut stop_reason = String::from("unknown");
        let mut func_calls: HashMap<String, CodexFuncCall> = HashMap::new();

        let full_body = response.text().await.expect("failed to read response body");
        for line in full_body.lines() {
            let trimmed = line.trim();
            if !trimmed.starts_with("data: ") {
                continue;
            }
            let mut events = Vec::new();
            parse_codex_data(
                &trimmed[6..],
                &mut acc_text,
                &mut acc_reasoning,
                &mut usage,
                &mut response_id,
                &mut stop_reason,
                &mut func_calls,
                &mut events,
            );
        }

        assert_eq!(stop_reason, "stop");
        assert!(!acc_text.is_empty(), "expected non-empty text response");
        assert!(response_id.is_some(), "expected response_id");
    }

    /// WebSocket: basic text response.
    #[tokio::test]
    #[ignore]
    async fn codex_live_websocket_hello_world() {
        let headers = live_headers();
        let request = make_request(vec![user_message("Say hello world")], vec![]);
        let ws_url = codex_ws_url_from_api_url(CODEX_API_URL).unwrap();

        let (mut socket, _) = connect_codex_websocket(&ws_url, &headers, None)
            .await
            .expect("connect failed");

        send_ws_request(&mut socket, &request, None, None).await;
        let (result, response_id) = read_ws_response(&mut socket).await;

        assert_eq!(result.stop_reason, "stop");
        assert!(!result.text.is_empty(), "expected non-empty text response");
        assert!(response_id.is_some(), "expected response_id");
    }

    /// WebSocket: model calls a tool, verify we parse the tool call correctly.
    #[tokio::test]
    #[ignore]
    async fn codex_live_websocket_tool_call() {
        let headers = live_headers();
        let tools = vec![json!({
            "type": "function",
            "name": "add_numbers",
            "description": "Add two numbers together and return the result.",
            "parameters": {
                "type": "object",
                "properties": {
                    "a": { "type": "number", "description": "First number" },
                    "b": { "type": "number", "description": "Second number" },
                },
                "required": ["a", "b"],
                "additionalProperties": false,
            },
        })];

        let request = make_request(
            vec![user_message("What is 7 + 13? Use the add_numbers tool.")],
            tools,
        );
        let ws_url = codex_ws_url_from_api_url(CODEX_API_URL).unwrap();

        let (mut socket, _) = connect_codex_websocket(&ws_url, &headers, None)
            .await
            .expect("connect failed");

        send_ws_request(&mut socket, &request, None, None).await;
        let (result, response_id) = read_ws_response(&mut socket).await;

        // The model should stop to make a tool call, not produce a final text answer
        assert!(
            !result.tool_calls.is_empty(),
            "expected at least one tool call, got none"
        );
        let tc = &result.tool_calls[0];
        assert_eq!(tc.name, "add_numbers");

        // Verify parsed args are valid JSON with a and b
        let args = tc.args.as_object().expect("args should be a JSON object");
        assert!(args.contains_key("a"), "tool args missing 'a'");
        assert!(args.contains_key("b"), "tool args missing 'b'");

        assert!(response_id.is_some(), "expected response_id");
    }

    /// WebSocket: full tool-use roundtrip — model calls tool, we send result back,
    /// model produces final text answer. Exercises multi-turn on a single WebSocket
    /// connection with incremental input via previous_response_id.
    #[tokio::test]
    #[ignore]
    async fn codex_live_websocket_tool_roundtrip() {
        let headers = live_headers();
        let tools = vec![json!({
            "type": "function",
            "name": "add_numbers",
            "description": "Add two numbers together and return the result.",
            "parameters": {
                "type": "object",
                "properties": {
                    "a": { "type": "number", "description": "First number" },
                    "b": { "type": "number", "description": "Second number" },
                },
                "required": ["a", "b"],
                "additionalProperties": false,
            },
        })];

        let user_msg = user_message("What is 7 + 13? Use the add_numbers tool.");
        let request_1 = make_request(vec![user_msg.clone()], tools.clone());
        let ws_url = codex_ws_url_from_api_url(CODEX_API_URL).unwrap();

        let (mut socket, _) = connect_codex_websocket(&ws_url, &headers, None)
            .await
            .expect("connect failed");

        // Turn 1: get tool call
        send_ws_request(&mut socket, &request_1, None, None).await;
        let (result_1, response_id_1) = read_ws_response(&mut socket).await;

        assert!(
            !result_1.tool_calls.is_empty(),
            "turn 1: expected tool call"
        );
        let tc = &result_1.tool_calls[0];
        assert_eq!(tc.name, "add_numbers");
        let resp_id_1 = response_id_1.expect("turn 1: expected response_id");

        // Build turn 2 input: original user msg + model's output + our tool result
        let items_added = codex_items_added_from_result(&result_1);
        let mut turn_2_input = vec![user_msg];
        turn_2_input.extend(items_added.clone());
        turn_2_input.push(tool_output(&tc.id, "20"));

        let request_2 = make_request(turn_2_input, tools);

        // Compute incremental input — only the tool result should be sent
        let prev_response = CodexLastResponse {
            response_id: resp_id_1.clone(),
            items_added,
        };
        let incremental =
            codex_incremental_input(&request_2, &request_1, &prev_response);
        assert!(
            incremental.is_some(),
            "incremental input optimization should apply"
        );
        let delta = incremental.unwrap();
        assert_eq!(
            delta.len(),
            1,
            "incremental delta should contain only the tool result"
        );

        // Turn 2: send tool result with previous_response_id + incremental input
        send_ws_request(
            &mut socket,
            &request_2,
            Some(&resp_id_1),
            Some(delta),
        )
        .await;
        let (result_2, response_id_2) = read_ws_response(&mut socket).await;

        assert_eq!(result_2.stop_reason, "stop");
        assert!(
            !result_2.text.is_empty(),
            "turn 2: expected text response incorporating tool result"
        );
        assert!(
            result_2.text.contains("20"),
            "turn 2: expected response to mention the result '20', got: {}",
            result_2.text
        );
        assert!(response_id_2.is_some(), "turn 2: expected response_id");
    }

    /// WebSocket: multi-turn conversation reusing the same connection.
    /// Turn 1: ask a question. Turn 2: follow-up referencing previous answer.
    /// Validates incremental input and previous_response_id across plain text turns.
    #[tokio::test]
    #[ignore]
    async fn codex_live_websocket_multi_turn() {
        let headers = live_headers();
        let ws_url = codex_ws_url_from_api_url(CODEX_API_URL).unwrap();

        let (mut socket, _) = connect_codex_websocket(&ws_url, &headers, None)
            .await
            .expect("connect failed");

        // Turn 1
        let msg_1 = user_message("What is the capital of France? Reply with just the city name.");
        let request_1 = make_request(vec![msg_1.clone()], vec![]);

        send_ws_request(&mut socket, &request_1, None, None).await;
        let (result_1, response_id_1) = read_ws_response(&mut socket).await;

        assert_eq!(result_1.stop_reason, "stop");
        assert!(!result_1.text.is_empty(), "turn 1: expected text");
        let resp_id_1 = response_id_1.expect("turn 1: expected response_id");

        // Turn 2: follow-up that references the previous answer
        let items_added = codex_items_added_from_result(&result_1);
        let msg_2 = user_message("What country is that city in? Reply with just the country name.");
        let mut turn_2_input = vec![msg_1];
        turn_2_input.extend(items_added.clone());
        turn_2_input.push(msg_2);

        let request_2 = make_request(turn_2_input, vec![]);

        // Verify incremental input optimization applies
        let prev_response = CodexLastResponse {
            response_id: resp_id_1.clone(),
            items_added,
        };
        let incremental =
            codex_incremental_input(&request_2, &request_1, &prev_response);
        assert!(
            incremental.is_some(),
            "incremental input optimization should apply for multi-turn"
        );
        let delta = incremental.unwrap();
        assert_eq!(
            delta.len(),
            1,
            "incremental delta should contain only the new user message"
        );

        send_ws_request(
            &mut socket,
            &request_2,
            Some(&resp_id_1),
            Some(delta),
        )
        .await;
        let (result_2, response_id_2) = read_ws_response(&mut socket).await;

        assert_eq!(result_2.stop_reason, "stop");
        assert!(!result_2.text.is_empty(), "turn 2: expected text");
        assert!(response_id_2.is_some(), "turn 2: expected response_id");
    }
}
