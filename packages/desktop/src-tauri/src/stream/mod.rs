mod anthropic;
mod codex;
mod openrouter;

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::ipc::Channel;
use tokio::sync::Mutex as AsyncMutex;

use anthropic::{finalize_anthropic_tools, parse_anthropic_data, AnthropicToolUse};
use codex::{
    codex_session_key, codex_turn_id, finalize_codex_tools, parse_codex_data,
    parse_codex_request_payload, try_codex_websocket_stream, update_codex_transport_session,
    CodexFuncCall, CodexRequestPayload, CodexTransportSession, CodexWebsocketError,
    X_CODEX_TURN_STATE_HEADER,
};
use openrouter::{finalize_openrouter_tools, parse_openrouter_data, ToolCallAccum};

// ---------------------------------------------------------------------------
// Public state — managed by Tauri
// ---------------------------------------------------------------------------

pub struct StreamCancellers {
    map: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl StreamCancellers {
    pub fn new() -> Self {
        Self {
            map: Mutex::new(HashMap::new()),
        }
    }
}

pub struct CodexTransportSessions {
    map: Mutex<HashMap<String, Arc<AsyncMutex<CodexTransportSession>>>>,
}

impl CodexTransportSessions {
    pub fn new() -> Self {
        Self {
            map: Mutex::new(HashMap::new()),
        }
    }

    fn get(&self, session_key: &str) -> Arc<AsyncMutex<CodexTransportSession>> {
        let mut map = self.map.lock().unwrap();
        map.entry(session_key.to_string())
            .or_insert_with(|| Arc::new(AsyncMutex::new(CodexTransportSession::default())))
            .clone()
    }
}

// ---------------------------------------------------------------------------
// Types (serialised to JS — tags must match the TS `StreamEvent` union)
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum StreamEvent {
    TextDelta {
        text: String,
    },
    ReasoningDelta {
        text: String,
    },
    ToolCallStart {
        #[serde(rename = "toolCallId")]
        tool_call_id: String,
        #[serde(rename = "toolName")]
        tool_name: String,
    },
    ToolCallArgsDelta {
        #[serde(rename = "toolCallId")]
        tool_call_id: String,
        args: String,
    },
    ToolCallComplete {
        #[serde(rename = "toolCallId")]
        tool_call_id: String,
        #[serde(rename = "toolName")]
        tool_name: String,
        args: serde_json::Value,
    },
    Error {
        error: String,
    },
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Usage {
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub total_tokens: u64,
}

#[derive(Serialize, Clone, Debug)]
pub struct ToolCallResult {
    pub id: String,
    pub name: String,
    pub args: serde_json::Value,
}

#[derive(Serialize, Clone, Debug)]
pub struct StreamResult {
    pub text: String,
    pub reasoning: String,
    #[serde(rename = "toolCalls")]
    pub tool_calls: Vec<ToolCallResult>,
    pub usage: Option<Usage>,
    /// Normalized finish reason: "stop", "tool_calls", "length", or "unknown".
    #[serde(rename = "stopReason")]
    pub stop_reason: String,
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
#[tracing::instrument(skip(headers, body, on_event, cancellers, codex_sessions))]
pub async fn stream_completion(
    url: String,
    headers: HashMap<String, String>,
    body: String,
    provider: String,
    stream_id: String,
    on_event: Channel<Vec<StreamEvent>>,
    cancellers: tauri::State<'_, Arc<StreamCancellers>>,
    codex_sessions: tauri::State<'_, Arc<CodexTransportSessions>>,
) -> Result<StreamResult, String> {
    let cancel_flag = Arc::new(AtomicBool::new(false));
    cancellers
        .map
        .lock()
        .unwrap()
        .insert(stream_id.clone(), cancel_flag.clone());

    let result = run_stream(
        url,
        headers,
        body,
        &provider,
        cancel_flag.clone(),
        &on_event,
        Arc::clone(codex_sessions.inner()),
    )
    .await;

    // Always clean up
    cancellers.map.lock().unwrap().remove(&stream_id);

    result
}

#[tauri::command]
#[tracing::instrument(skip(cancellers))]
pub async fn cancel_stream(
    stream_id: String,
    cancellers: tauri::State<'_, Arc<StreamCancellers>>,
) -> Result<(), String> {
    if let Some(flag) = cancellers.map.lock().unwrap().get(&stream_id) {
        flag.store(true, Ordering::Relaxed);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Core streaming orchestrator
// ---------------------------------------------------------------------------

#[tracing::instrument(skip(headers, body, cancel_flag, on_event, codex_sessions))]
async fn run_stream(
    url: String,
    headers: HashMap<String, String>,
    body: String,
    provider: &str,
    cancel_flag: Arc<AtomicBool>,
    on_event: &Channel<Vec<StreamEvent>>,
    codex_sessions: Arc<CodexTransportSessions>,
) -> Result<StreamResult, String> {
    let codex_request = if provider == "codex" {
        Some(parse_codex_request_payload(&body)?)
    } else {
        None
    };
    let codex_session = if provider == "codex" {
        codex_session_key(&headers).map(|session_key| codex_sessions.get(&session_key))
    } else {
        None
    };
    let codex_turn_id = if provider == "codex" {
        codex_turn_id(&headers)
    } else {
        None
    };

    if let Some(codex_session) = codex_session.as_ref() {
        let mut session = codex_session.lock().await;
        session.sync_turn_scope(codex_turn_id.as_deref());
    }

    if provider == "codex" {
        match try_codex_websocket_stream(
            url.clone(),
            headers.clone(),
            codex_request.clone().expect("codex request payload"),
            codex_session.clone(),
            Arc::clone(&cancel_flag),
            on_event,
        )
        .await
        {
            Ok(result) => return Ok(result),
            Err(CodexWebsocketError::Cancelled) => return Err("cancelled".to_string()),
            Err(CodexWebsocketError::Fatal(err)) => return Err(err),
            Err(CodexWebsocketError::Fallback { reason, .. }) => {
                tracing::info!(reason = %reason, "falling back to Codex HTTP SSE");
            }
        }
    }

    run_http_stream(
        url,
        headers,
        body,
        provider,
        cancel_flag,
        on_event,
        codex_request.as_ref(),
        codex_session.as_ref(),
    )
    .await
}

// ---------------------------------------------------------------------------
// HTTP SSE streaming (shared across all providers)
// ---------------------------------------------------------------------------

#[tracing::instrument(skip(headers, body, cancel_flag, on_event, codex_request, codex_session))]
async fn run_http_stream(
    url: String,
    headers: HashMap<String, String>,
    body: String,
    provider: &str,
    cancel_flag: Arc<AtomicBool>,
    on_event: &Channel<Vec<StreamEvent>>,
    codex_request: Option<&CodexRequestPayload>,
    codex_session: Option<&Arc<AsyncMutex<CodexTransportSession>>>,
) -> Result<StreamResult, String> {
    let client = reqwest::Client::new();
    let codex_turn_state = if provider == "codex" {
        if let Some(codex_session) = codex_session {
            let session = codex_session.lock().await;
            session.turn_state.clone()
        } else {
            None
        }
    } else {
        None
    };

    let mut req_builder = client.post(&url).body(body);
    for (k, v) in &headers {
        req_builder = req_builder.header(k, v);
    }
    if let Some(turn_state) = codex_turn_state {
        req_builder = req_builder.header(X_CODEX_TURN_STATE_HEADER, turn_state);
    }

    let response = req_builder
        .send()
        .await
        .map_err(|e| format!("HTTP request failed: {}", e))?;

    let status = response.status();
    if !status.is_success() {
        let err_body = response.text().await.unwrap_or_default();
        let label = match provider {
            "codex" => "Codex",
            "anthropic" => "Anthropic",
            _ => "OpenRouter",
        };
        return Err(format!(
            "{} API error ({}): {}",
            label,
            status.as_u16(),
            err_body
        ));
    }

    let codex_response_turn_state = if provider == "codex" {
        response
            .headers()
            .get(X_CODEX_TURN_STATE_HEADER)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string)
    } else {
        None
    };
    if let Some(codex_session) = codex_session {
        let mut session = codex_session.lock().await;
        session.remember_turn_state(codex_response_turn_state);
    }

    // Accumulators
    let mut acc_text = String::new();
    let mut acc_reasoning = String::new();
    let mut usage: Option<Usage> = None;
    let mut codex_response_id = None;
    let mut stop_reason = String::from("unknown");
    let mut or_tool_calls: HashMap<usize, ToolCallAccum> = HashMap::new();
    let mut codex_func_calls: HashMap<String, CodexFuncCall> = HashMap::new();
    let mut anthropic_tool_uses: HashMap<usize, AnthropicToolUse> = HashMap::new();

    // Line buffer for SSE parsing
    let mut line_buf = String::new();
    // Event batch + timing
    let mut event_batch: Vec<StreamEvent> = Vec::new();
    let mut last_flush = std::time::Instant::now();

    let mut stream = response;

    // We iterate chunk by chunk using reqwest's chunk() method
    loop {
        if cancel_flag.load(Ordering::Relaxed) {
            return Err("cancelled".to_string());
        }

        let chunk = stream
            .chunk()
            .await
            .map_err(|e| format!("Stream read error: {}", e))?;

        let bytes = match chunk {
            Some(b) => b,
            None => break, // End of stream
        };

        // Append to line buffer
        let text = String::from_utf8_lossy(&bytes);
        line_buf.push_str(&text);

        // Process complete lines
        while let Some(newline_pos) = line_buf.find('\n') {
            let line = line_buf[..newline_pos].to_string();
            line_buf = line_buf[newline_pos + 1..].to_string();

            let trimmed = line.trim();
            if trimmed.is_empty() || !trimmed.starts_with("data: ") {
                continue;
            }
            let data = &trimmed[6..];

            let mut line_events = Vec::new();
            match provider {
                "openrouter" => parse_openrouter_data(
                    data,
                    &mut acc_text,
                    &mut acc_reasoning,
                    &mut usage,
                    &mut stop_reason,
                    &mut or_tool_calls,
                    &mut line_events,
                ),
                "codex" => parse_codex_data(
                    data,
                    &mut acc_text,
                    &mut acc_reasoning,
                    &mut usage,
                    &mut codex_response_id,
                    &mut stop_reason,
                    &mut codex_func_calls,
                    &mut line_events,
                ),
                "anthropic" => parse_anthropic_data(
                    data,
                    &mut acc_text,
                    &mut acc_reasoning,
                    &mut usage,
                    &mut stop_reason,
                    &mut anthropic_tool_uses,
                    &mut line_events,
                ),
                _ => {
                    return Err(format!("Unknown provider: {}", provider));
                }
            }

            // Check if any event is structural (flush immediately)
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
        }
    }

    // Flush remaining events from SSE parsing
    if !event_batch.is_empty() {
        let batch = std::mem::take(&mut event_batch);
        let _ = on_event.send(batch);
    }

    // Finalize tool calls
    let mut final_events = Vec::new();
    let tool_calls = match provider {
        "openrouter" => finalize_openrouter_tools(or_tool_calls, &mut final_events),
        "codex" => finalize_codex_tools(codex_func_calls, &mut final_events),
        "anthropic" => finalize_anthropic_tools(anthropic_tool_uses, &mut final_events),
        _ => Vec::new(),
    };

    if !final_events.is_empty() {
        let _ = on_event.send(final_events);
    }

    let result = StreamResult {
        text: acc_text,
        reasoning: acc_reasoning,
        tool_calls,
        usage,
        stop_reason,
    };

    if provider == "codex" {
        if let Some(codex_request) = codex_request {
            update_codex_transport_session(
                codex_session,
                None,
                codex_request,
                codex_response_id,
                &result,
            )
            .await;
        }
    }

    Ok(result)
}
