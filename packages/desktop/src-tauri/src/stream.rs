use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::ipc::Channel;

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
}

// ---------------------------------------------------------------------------
// Internal accumulator state
// ---------------------------------------------------------------------------

struct ToolCallAccum {
    id: String,
    name: String,
    args: String,
}

struct CodexFuncCall {
    call_id: String,
    name: String,
    args: String,
}

struct AnthropicToolUse {
    id: String,
    name: String,
    args: String,
}

// ---------------------------------------------------------------------------
// SSE line parsers
// ---------------------------------------------------------------------------

fn parse_openrouter_data(
    data: &str,
    acc_text: &mut String,
    acc_reasoning: &mut String,
    usage: &mut Option<Usage>,
    tool_calls: &mut HashMap<usize, ToolCallAccum>,
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

    // Usage
    if let Some(u) = parsed.get("usage") {
        if let (Some(pt), Some(ct), Some(tt)) = (
            u.get("prompt_tokens").and_then(|v| v.as_u64()),
            u.get("completion_tokens").and_then(|v| v.as_u64()),
            u.get("total_tokens").and_then(|v| v.as_u64()),
        ) {
            *usage = Some(Usage {
                prompt_tokens: pt,
                completion_tokens: ct,
                total_tokens: tt,
            });
        }
    }

    let delta = match parsed.pointer("/choices/0/delta") {
        Some(d) => d,
        None => return,
    };

    // Reasoning (delta.reasoning)
    if let Some(r) = delta.get("reasoning").and_then(|v| v.as_str()) {
        acc_reasoning.push_str(r);
        events.push(StreamEvent::ReasoningDelta {
            text: r.to_string(),
        });
    }

    // Reasoning (delta.reasoning_details)
    if let Some(details) = delta.get("reasoning_details").and_then(|v| v.as_array()) {
        for detail in details {
            if detail.get("type").and_then(|v| v.as_str()) == Some("thinking") {
                if let Some(thinking) = detail.get("thinking").and_then(|v| v.as_str()) {
                    acc_reasoning.push_str(thinking);
                    events.push(StreamEvent::ReasoningDelta {
                        text: thinking.to_string(),
                    });
                }
            }
        }
    }

    // Text content
    if let Some(content) = delta.get("content").and_then(|v| v.as_str()) {
        acc_text.push_str(content);
        events.push(StreamEvent::TextDelta {
            text: content.to_string(),
        });
    }

    // Tool calls
    if let Some(tcs) = delta.get("tool_calls").and_then(|v| v.as_array()) {
        for tc in tcs {
            let idx = tc.get("index").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
            let accum = tool_calls.entry(idx).or_insert_with(|| ToolCallAccum {
                id: String::new(),
                name: String::new(),
                args: String::new(),
            });

            if let Some(id) = tc.get("id").and_then(|v| v.as_str()) {
                accum.id = id.to_string();
            }
            if let Some(name) = tc.pointer("/function/name").and_then(|v| v.as_str()) {
                accum.name = name.to_string();
                events.push(StreamEvent::ToolCallStart {
                    tool_call_id: accum.id.clone(),
                    tool_name: accum.name.clone(),
                });
            }
            if let Some(args) = tc.pointer("/function/arguments").and_then(|v| v.as_str()) {
                accum.args.push_str(args);
                events.push(StreamEvent::ToolCallArgsDelta {
                    tool_call_id: accum.id.clone(),
                    args: args.to_string(),
                });
            }
        }
    }
}

fn parse_codex_data(
    data: &str,
    acc_text: &mut String,
    acc_reasoning: &mut String,
    usage: &mut Option<Usage>,
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
                    let item_id = item.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    let call_id = item
                        .get("call_id")
                        .and_then(|v| v.as_str())
                        .unwrap_or(&item_id)
                        .to_string();
                    let name = item.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();

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
            if let Some(resp) = parsed.get("response") {
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
        _ => {} // Ignore unknown event types
    }
}

fn parse_anthropic_data(
    data: &str,
    acc_text: &mut String,
    acc_reasoning: &mut String,
    usage: &mut Option<Usage>,
    tool_uses: &mut HashMap<usize, AnthropicToolUse>,
    events: &mut Vec<StreamEvent>,
) {
    let parsed: serde_json::Value = match serde_json::from_str(data) {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!(error = %e, "skipping malformed Anthropic SSE chunk: {}", &data[..data.len().min(200)]);
            return;
        }
    };

    let event_type = match parsed.get("type").and_then(|v| v.as_str()) {
        Some(t) => t,
        None => return,
    };

    match event_type {
        "message_start" => {
            // Extract input token usage from the initial message
            if let Some(u) = parsed.pointer("/message/usage") {
                let input = u.get("input_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
                let output = u.get("output_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
                *usage = Some(Usage {
                    prompt_tokens: input,
                    completion_tokens: output,
                    total_tokens: input + output,
                });
            }
        }
        "content_block_start" => {
            let index = parsed.get("index").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
            if let Some(block) = parsed.get("content_block") {
                let block_type = block.get("type").and_then(|v| v.as_str()).unwrap_or("");
                if block_type == "tool_use" {
                    let id = block.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    let name = block.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    tool_uses.insert(index, AnthropicToolUse {
                        id: id.clone(),
                        name: name.clone(),
                        args: String::new(),
                    });
                    if !name.is_empty() {
                        events.push(StreamEvent::ToolCallStart {
                            tool_call_id: id,
                            tool_name: name,
                        });
                    }
                }
            }
        }
        "content_block_delta" => {
            let index = parsed.get("index").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
            if let Some(delta) = parsed.get("delta") {
                let delta_type = delta.get("type").and_then(|v| v.as_str()).unwrap_or("");
                match delta_type {
                    "text_delta" => {
                        if let Some(text) = delta.get("text").and_then(|v| v.as_str()) {
                            acc_text.push_str(text);
                            events.push(StreamEvent::TextDelta {
                                text: text.to_string(),
                            });
                        }
                    }
                    "thinking_delta" => {
                        if let Some(thinking) = delta.get("thinking").and_then(|v| v.as_str()) {
                            acc_reasoning.push_str(thinking);
                            events.push(StreamEvent::ReasoningDelta {
                                text: thinking.to_string(),
                            });
                        }
                    }
                    "input_json_delta" => {
                        if let Some(json_str) = delta.get("partial_json").and_then(|v| v.as_str()) {
                            if let Some(tu) = tool_uses.get_mut(&index) {
                                tu.args.push_str(json_str);
                                events.push(StreamEvent::ToolCallArgsDelta {
                                    tool_call_id: tu.id.clone(),
                                    args: json_str.to_string(),
                                });
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
        "message_delta" => {
            // Final usage update (output tokens)
            if let Some(u) = parsed.get("usage") {
                let output = u.get("output_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
                if let Some(ref mut existing) = usage {
                    existing.completion_tokens = output;
                    existing.total_tokens = existing.prompt_tokens + output;
                }
            }
        }
        "error" => {
            let msg = parsed
                .pointer("/error/message")
                .and_then(|v| v.as_str())
                .unwrap_or("Unknown Anthropic API error");
            events.push(StreamEvent::Error {
                error: msg.to_string(),
            });
        }
        _ => {} // message_stop, content_block_stop, ping, etc.
    }
}

fn finalize_anthropic_tools(
    tool_uses: HashMap<usize, AnthropicToolUse>,
    events: &mut Vec<StreamEvent>,
) -> Vec<ToolCallResult> {
    let mut sorted: Vec<(usize, AnthropicToolUse)> = tool_uses.into_iter().collect();
    sorted.sort_by_key(|(idx, _)| *idx);

    sorted
        .into_iter()
        .map(|(_, tu)| {
            let parsed_args: serde_json::Value = serde_json::from_str(&tu.args)
                .unwrap_or_else(|_| {
                    tracing::warn!(tool = %tu.name, "failed to parse Anthropic tool args: {}", &tu.args[..tu.args.len().min(200)]);
                    serde_json::Value::Object(serde_json::Map::new())
                });
            events.push(StreamEvent::ToolCallComplete {
                tool_call_id: tu.id.clone(),
                tool_name: tu.name.clone(),
                args: parsed_args.clone(),
            });
            ToolCallResult {
                id: tu.id,
                name: tu.name,
                args: parsed_args,
            }
        })
        .collect()
}

/// Finalize accumulated tool calls into `ToolCallComplete` events and `ToolCallResult`s.
fn finalize_openrouter_tools(
    tool_calls: HashMap<usize, ToolCallAccum>,
    events: &mut Vec<StreamEvent>,
) -> Vec<ToolCallResult> {
    let mut sorted: Vec<(usize, ToolCallAccum)> = tool_calls.into_iter().collect();
    sorted.sort_by_key(|(idx, _)| *idx);

    sorted
        .into_iter()
        .map(|(_, tc)| {
            let parsed_args: serde_json::Value = serde_json::from_str(&tc.args)
                .unwrap_or_else(|_| {
                    tracing::warn!(tool = %tc.name, "failed to parse tool args: {}", &tc.args[..tc.args.len().min(200)]);
                    serde_json::Value::Object(serde_json::Map::new())
                });
            events.push(StreamEvent::ToolCallComplete {
                tool_call_id: tc.id.clone(),
                tool_name: tc.name.clone(),
                args: parsed_args.clone(),
            });
            ToolCallResult {
                id: tc.id,
                name: tc.name,
                args: parsed_args,
            }
        })
        .collect()
}

fn finalize_codex_tools(
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
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
#[tracing::instrument(skip(headers, body, on_event, cancellers))]
pub async fn stream_completion(
    url: String,
    headers: HashMap<String, String>,
    body: String,
    provider: String,
    stream_id: String,
    on_event: Channel<Vec<StreamEvent>>,
    cancellers: tauri::State<'_, Arc<StreamCancellers>>,
) -> Result<StreamResult, String> {
    let cancel_flag = Arc::new(AtomicBool::new(false));
    cancellers
        .map
        .lock()
        .unwrap()
        .insert(stream_id.clone(), cancel_flag.clone());

    let result = run_stream(url, headers, body, &provider, cancel_flag.clone(), &on_event).await;

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
// Core streaming loop
// ---------------------------------------------------------------------------

#[tracing::instrument(skip(headers, body, cancel_flag, on_event))]
async fn run_stream(
    url: String,
    headers: HashMap<String, String>,
    body: String,
    provider: &str,
    cancel_flag: Arc<AtomicBool>,
    on_event: &Channel<Vec<StreamEvent>>,
) -> Result<StreamResult, String> {
    let client = reqwest::Client::new();

    let mut req_builder = client.post(&url).body(body);
    for (k, v) in &headers {
        req_builder = req_builder.header(k, v);
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
        return Err(format!("{} API error ({}): {}", label, status.as_u16(), err_body));
    }

    // Accumulators
    let mut acc_text = String::new();
    let mut acc_reasoning = String::new();
    let mut usage: Option<Usage> = None;
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
                    &mut or_tool_calls,
                    &mut line_events,
                ),
                "codex" => parse_codex_data(
                    data,
                    &mut acc_text,
                    &mut acc_reasoning,
                    &mut usage,
                    &mut codex_func_calls,
                    &mut line_events,
                ),
                "anthropic" => parse_anthropic_data(
                    data,
                    &mut acc_text,
                    &mut acc_reasoning,
                    &mut usage,
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

    Ok(StreamResult {
        text: acc_text,
        reasoning: acc_reasoning,
        tool_calls,
        usage,
    })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // Helper to run the openrouter parser on a single data line
    fn parse_or(data: &str) -> (String, String, Option<Usage>, HashMap<usize, ToolCallAccum>, Vec<StreamEvent>) {
        let mut text = String::new();
        let mut reasoning = String::new();
        let mut usage = None;
        let mut tool_calls = HashMap::new();
        let mut events = Vec::new();
        parse_openrouter_data(data, &mut text, &mut reasoning, &mut usage, &mut tool_calls, &mut events);
        (text, reasoning, usage, tool_calls, events)
    }

    fn parse_cx(data: &str) -> (String, String, Option<Usage>, HashMap<String, CodexFuncCall>, Vec<StreamEvent>) {
        let mut text = String::new();
        let mut reasoning = String::new();
        let mut usage = None;
        let mut func_calls = HashMap::new();
        let mut events = Vec::new();
        parse_codex_data(data, &mut text, &mut reasoning, &mut usage, &mut func_calls, &mut events);
        (text, reasoning, usage, func_calls, events)
    }

    #[test]
    fn test_parse_openrouter_text_delta() {
        let (text, _, _, _, events) =
            parse_or(r#"{"choices":[{"delta":{"content":"Hello"}}]}"#);
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
    fn test_parse_openrouter_reasoning() {
        let (_, reasoning, _, _, events) =
            parse_or(r#"{"choices":[{"delta":{"reasoning":"Think"}}]}"#);
        assert_eq!(reasoning, "Think");
        assert_eq!(
            events[0],
            StreamEvent::ReasoningDelta {
                text: "Think".into()
            }
        );
    }

    #[test]
    fn test_parse_openrouter_reasoning_details() {
        let (_, reasoning, _, _, events) = parse_or(
            r#"{"choices":[{"delta":{"reasoning_details":[{"type":"thinking","thinking":"Deep"}]}}]}"#,
        );
        assert_eq!(reasoning, "Deep");
        assert_eq!(
            events[0],
            StreamEvent::ReasoningDelta {
                text: "Deep".into()
            }
        );
    }

    #[test]
    fn test_parse_openrouter_tool_calls() {
        let mut text = String::new();
        let mut reasoning = String::new();
        let mut usage = None;
        let mut tool_calls: HashMap<usize, ToolCallAccum> = HashMap::new();
        let mut events = Vec::new();

        // First chunk: tool call start
        parse_openrouter_data(
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"get_weather","arguments":""}}]}}]}"#,
            &mut text, &mut reasoning, &mut usage, &mut tool_calls, &mut events,
        );
        // Second chunk: args delta
        parse_openrouter_data(
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"city\""}}]}}]}"#,
            &mut text, &mut reasoning, &mut usage, &mut tool_calls, &mut events,
        );
        // Third chunk: more args
        parse_openrouter_data(
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":": \"Paris\"}"}}]}}]}"#,
            &mut text, &mut reasoning, &mut usage, &mut tool_calls, &mut events,
        );

        assert_eq!(tool_calls.len(), 1);
        let tc = tool_calls.get(&0).unwrap();
        assert_eq!(tc.id, "call_1");
        assert_eq!(tc.name, "get_weather");
        assert_eq!(tc.args, r#"{"city": "Paris"}"#);

        // Should have: start, args-delta (empty), args-delta, args-delta
        assert!(events.iter().any(|e| matches!(e, StreamEvent::ToolCallStart { .. })));
        let args_deltas: Vec<_> = events
            .iter()
            .filter(|e| matches!(e, StreamEvent::ToolCallArgsDelta { .. }))
            .collect();
        assert_eq!(args_deltas.len(), 3); // empty string, first chunk, second chunk
    }

    #[test]
    fn test_parse_openrouter_usage() {
        let (_, _, usage, _, _) = parse_or(
            r#"{"choices":[{"delta":{}}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}"#,
        );
        let u = usage.unwrap();
        assert_eq!(u.prompt_tokens, 10);
        assert_eq!(u.completion_tokens, 5);
        assert_eq!(u.total_tokens, 15);
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
        let mut func_calls: HashMap<String, CodexFuncCall> = HashMap::new();
        let mut events = Vec::new();

        // 1. Item added
        parse_codex_data(
            r#"{"type":"response.output_item.added","item":{"type":"function_call","id":"fc_1","call_id":"fc_1","name":"read"}}"#,
            &mut text, &mut reasoning, &mut usage, &mut func_calls, &mut events,
        );
        // 2. Args delta
        parse_codex_data(
            r#"{"type":"response.function_call_arguments.delta","item_id":"fc_1","delta":"{\"path\":"}"#,
            &mut text, &mut reasoning, &mut usage, &mut func_calls, &mut events,
        );
        // 3. More args
        parse_codex_data(
            r#"{"type":"response.function_call_arguments.delta","item_id":"fc_1","delta":"\"foo\"}"}"#,
            &mut text, &mut reasoning, &mut usage, &mut func_calls, &mut events,
        );
        // 4. Item done (with final arguments)
        parse_codex_data(
            r#"{"type":"response.output_item.done","item":{"type":"function_call","id":"fc_1","arguments":"{\"path\":\"foo\"}"}}"#,
            &mut text, &mut reasoning, &mut usage, &mut func_calls, &mut events,
        );

        assert_eq!(func_calls.len(), 1);
        let fc = func_calls.get("fc_1").unwrap();
        assert_eq!(fc.name, "read");
        assert_eq!(fc.args, r#"{"path":"foo"}"#);

        assert!(events.iter().any(|e| matches!(e, StreamEvent::ToolCallStart { .. })));
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
    fn test_malformed_json_skipped() {
        let (text, _, _, _, events) = parse_or("not valid json {{{");
        assert_eq!(text, "");
        assert!(events.is_empty());
    }

    #[test]
    fn test_done_line_skipped() {
        let (text, _, _, _, events) = parse_or("[DONE]");
        assert_eq!(text, "");
        assert!(events.is_empty());
    }

    #[test]
    fn test_finalize_openrouter_tools_emits_complete() {
        let mut tool_calls = HashMap::new();
        tool_calls.insert(
            0,
            ToolCallAccum {
                id: "call_1".into(),
                name: "read".into(),
                args: r#"{"path":"foo"}"#.into(),
            },
        );
        let mut events = Vec::new();
        let results = finalize_openrouter_tools(tool_calls, &mut events);

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].id, "call_1");
        assert_eq!(results[0].name, "read");
        assert_eq!(results[0].args, serde_json::json!({"path": "foo"}));

        assert_eq!(events.len(), 1);
        assert!(matches!(&events[0], StreamEvent::ToolCallComplete { .. }));
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

    // --- Anthropic parser tests ---

    fn parse_an(data: &str) -> (String, String, Option<Usage>, HashMap<usize, AnthropicToolUse>, Vec<StreamEvent>) {
        let mut text = String::new();
        let mut reasoning = String::new();
        let mut usage = None;
        let mut tool_uses = HashMap::new();
        let mut events = Vec::new();
        parse_anthropic_data(data, &mut text, &mut reasoning, &mut usage, &mut tool_uses, &mut events);
        (text, reasoning, usage, tool_uses, events)
    }

    #[test]
    fn test_parse_anthropic_text_delta() {
        let (text, _, _, _, events) = parse_an(
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}"#,
        );
        assert_eq!(text, "Hello");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0], StreamEvent::TextDelta { text: "Hello".into() });
    }

    #[test]
    fn test_parse_anthropic_thinking_delta() {
        let (_, reasoning, _, _, events) = parse_an(
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Let me think..."}}"#,
        );
        assert_eq!(reasoning, "Let me think...");
        assert_eq!(events[0], StreamEvent::ReasoningDelta { text: "Let me think...".into() });
    }

    #[test]
    fn test_parse_anthropic_tool_use_flow() {
        let mut text = String::new();
        let mut reasoning = String::new();
        let mut usage = None;
        let mut tool_uses: HashMap<usize, AnthropicToolUse> = HashMap::new();
        let mut events = Vec::new();

        // 1. content_block_start with tool_use
        parse_anthropic_data(
            r#"{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_abc","name":"read"}}"#,
            &mut text, &mut reasoning, &mut usage, &mut tool_uses, &mut events,
        );
        // 2. input_json_delta
        parse_anthropic_data(
            r#"{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"path\":"}}"#,
            &mut text, &mut reasoning, &mut usage, &mut tool_uses, &mut events,
        );
        // 3. more input_json_delta
        parse_anthropic_data(
            r#"{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\"foo.txt\"}"}}"#,
            &mut text, &mut reasoning, &mut usage, &mut tool_uses, &mut events,
        );

        assert_eq!(tool_uses.len(), 1);
        let tu = tool_uses.get(&1).unwrap();
        assert_eq!(tu.id, "toolu_abc");
        assert_eq!(tu.name, "read");
        assert_eq!(tu.args, r#"{"path":"foo.txt"}"#);

        assert!(events.iter().any(|e| matches!(e, StreamEvent::ToolCallStart { .. })));
        let args_deltas: Vec<_> = events.iter().filter(|e| matches!(e, StreamEvent::ToolCallArgsDelta { .. })).collect();
        assert_eq!(args_deltas.len(), 2);
    }

    #[test]
    fn test_parse_anthropic_usage() {
        let mut text = String::new();
        let mut reasoning = String::new();
        let mut usage = None;
        let mut tool_uses = HashMap::new();
        let mut events = Vec::new();

        // message_start with input usage
        parse_anthropic_data(
            r#"{"type":"message_start","message":{"usage":{"input_tokens":100,"output_tokens":0}}}"#,
            &mut text, &mut reasoning, &mut usage, &mut tool_uses, &mut events,
        );
        assert_eq!(usage.as_ref().unwrap().prompt_tokens, 100);

        // message_delta with output usage
        parse_anthropic_data(
            r#"{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":50}}"#,
            &mut text, &mut reasoning, &mut usage, &mut tool_uses, &mut events,
        );
        let u = usage.unwrap();
        assert_eq!(u.prompt_tokens, 100);
        assert_eq!(u.completion_tokens, 50);
        assert_eq!(u.total_tokens, 150);
    }

    #[test]
    fn test_parse_anthropic_error() {
        let (_, _, _, _, events) = parse_an(
            r#"{"type":"error","error":{"type":"rate_limit_error","message":"Rate limit exceeded"}}"#,
        );
        assert_eq!(events.len(), 1);
        assert_eq!(events[0], StreamEvent::Error { error: "Rate limit exceeded".into() });
    }

    #[test]
    fn test_finalize_anthropic_tools_emits_complete() {
        let mut tool_uses = HashMap::new();
        tool_uses.insert(0, AnthropicToolUse {
            id: "toolu_abc".into(),
            name: "read".into(),
            args: r#"{"path":"foo"}"#.into(),
        });
        let mut events = Vec::new();
        let results = finalize_anthropic_tools(tool_uses, &mut events);

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].id, "toolu_abc");
        assert_eq!(results[0].name, "read");
        assert_eq!(results[0].args, serde_json::json!({"path": "foo"}));
        assert!(matches!(&events[0], StreamEvent::ToolCallComplete { .. }));
    }

    #[test]
    fn test_codex_error_event() {
        let (_, _, _, _, events) =
            parse_cx(r#"{"type":"error","message":"Rate limit exceeded"}"#);
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
}
