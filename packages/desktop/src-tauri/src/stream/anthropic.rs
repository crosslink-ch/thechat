use std::collections::HashMap;

use super::{StreamEvent, ToolCallResult, Usage};

pub(super) struct AnthropicToolUse {
    pub id: String,
    pub name: String,
    pub args: String,
}

pub(super) fn parse_anthropic_data(
    data: &str,
    acc_text: &mut String,
    acc_reasoning: &mut String,
    usage: &mut Option<Usage>,
    stop_reason: &mut String,
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
                    let id = block
                        .get("id")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let name = block
                        .get("name")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    tool_uses.insert(
                        index,
                        AnthropicToolUse {
                            id: id.clone(),
                            name: name.clone(),
                            args: String::new(),
                        },
                    );
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
            // Normalize Anthropic stop_reason to our standard values
            if let Some(reason) = parsed
                .pointer("/delta/stop_reason")
                .and_then(|v| v.as_str())
            {
                *stop_reason = match reason {
                    "end_turn" => "stop".to_string(),
                    "tool_use" => "tool_calls".to_string(),
                    "max_tokens" => "length".to_string(),
                    other => other.to_string(),
                };
            }
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

pub(super) fn finalize_anthropic_tools(
    tool_uses: HashMap<usize, AnthropicToolUse>,
    events: &mut Vec<StreamEvent>,
) -> Vec<ToolCallResult> {
    let mut sorted: Vec<(usize, AnthropicToolUse)> = tool_uses.into_iter().collect();
    sorted.sort_by_key(|(idx, _)| *idx);

    sorted
        .into_iter()
        .map(|(_, tu)| {
            let parsed_args: serde_json::Value = if tu.args.is_empty() {
                tracing::warn!(tool = %tu.name, "tool call has empty args (response likely truncated by max_tokens)");
                serde_json::Value::Object(serde_json::Map::new())
            } else {
                serde_json::from_str(&tu.args).unwrap_or_else(|_| {
                    tracing::warn!(tool = %tu.name, "failed to parse Anthropic tool args: {}", &tu.args[..tu.args.len().min(200)]);
                    serde_json::Value::Object(serde_json::Map::new())
                })
            };
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn parse_an(
        data: &str,
    ) -> (
        String,
        String,
        Option<Usage>,
        HashMap<usize, AnthropicToolUse>,
        Vec<StreamEvent>,
    ) {
        let mut text = String::new();
        let mut reasoning = String::new();
        let mut usage = None;
        let mut stop_reason = String::from("unknown");
        let mut tool_uses = HashMap::new();
        let mut events = Vec::new();
        parse_anthropic_data(
            data,
            &mut text,
            &mut reasoning,
            &mut usage,
            &mut stop_reason,
            &mut tool_uses,
            &mut events,
        );
        (text, reasoning, usage, tool_uses, events)
    }

    #[test]
    fn test_parse_anthropic_text_delta() {
        let (text, _, _, _, events) = parse_an(
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}"#,
        );
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
    fn test_parse_anthropic_thinking_delta() {
        let (_, reasoning, _, _, events) = parse_an(
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Let me think..."}}"#,
        );
        assert_eq!(reasoning, "Let me think...");
        assert_eq!(
            events[0],
            StreamEvent::ReasoningDelta {
                text: "Let me think...".into()
            }
        );
    }

    #[test]
    fn test_parse_anthropic_tool_use_flow() {
        let mut text = String::new();
        let mut reasoning = String::new();
        let mut usage = None;
        let mut stop_reason = String::from("unknown");
        let mut tool_uses: HashMap<usize, AnthropicToolUse> = HashMap::new();
        let mut events = Vec::new();

        // 1. content_block_start with tool_use
        parse_anthropic_data(
            r#"{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_abc","name":"read"}}"#,
            &mut text,
            &mut reasoning,
            &mut usage,
            &mut stop_reason,
            &mut tool_uses,
            &mut events,
        );
        // 2. input_json_delta
        parse_anthropic_data(
            r#"{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"path\":"}}"#,
            &mut text,
            &mut reasoning,
            &mut usage,
            &mut stop_reason,
            &mut tool_uses,
            &mut events,
        );
        // 3. more input_json_delta
        parse_anthropic_data(
            r#"{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\"foo.txt\"}"}}"#,
            &mut text,
            &mut reasoning,
            &mut usage,
            &mut stop_reason,
            &mut tool_uses,
            &mut events,
        );

        assert_eq!(tool_uses.len(), 1);
        let tu = tool_uses.get(&1).unwrap();
        assert_eq!(tu.id, "toolu_abc");
        assert_eq!(tu.name, "read");
        assert_eq!(tu.args, r#"{"path":"foo.txt"}"#);

        assert!(events
            .iter()
            .any(|e| matches!(e, StreamEvent::ToolCallStart { .. })));
        let args_deltas: Vec<_> = events
            .iter()
            .filter(|e| matches!(e, StreamEvent::ToolCallArgsDelta { .. }))
            .collect();
        assert_eq!(args_deltas.len(), 2);
    }

    #[test]
    fn test_parse_anthropic_usage() {
        let mut text = String::new();
        let mut reasoning = String::new();
        let mut usage = None;
        let mut stop_reason = String::from("unknown");
        let mut tool_uses = HashMap::new();
        let mut events = Vec::new();

        // message_start with input usage
        parse_anthropic_data(
            r#"{"type":"message_start","message":{"usage":{"input_tokens":100,"output_tokens":0}}}"#,
            &mut text,
            &mut reasoning,
            &mut usage,
            &mut stop_reason,
            &mut tool_uses,
            &mut events,
        );
        assert_eq!(usage.as_ref().unwrap().prompt_tokens, 100);

        // message_delta with output usage
        parse_anthropic_data(
            r#"{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":50}}"#,
            &mut text,
            &mut reasoning,
            &mut usage,
            &mut stop_reason,
            &mut tool_uses,
            &mut events,
        );
        assert_eq!(stop_reason, "stop");
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
        assert_eq!(
            events[0],
            StreamEvent::Error {
                error: "Rate limit exceeded".into()
            }
        );
    }

    #[test]
    fn test_finalize_anthropic_tools_emits_complete() {
        let mut tool_uses = HashMap::new();
        tool_uses.insert(
            0,
            AnthropicToolUse {
                id: "toolu_abc".into(),
                name: "read".into(),
                args: r#"{"path":"foo"}"#.into(),
            },
        );
        let mut events = Vec::new();
        let results = finalize_anthropic_tools(tool_uses, &mut events);

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].id, "toolu_abc");
        assert_eq!(results[0].name, "read");
        assert_eq!(results[0].args, serde_json::json!({"path": "foo"}));
        assert!(matches!(&events[0], StreamEvent::ToolCallComplete { .. }));
    }

    // -----------------------------------------------------------------------
    // Live test helpers
    // -----------------------------------------------------------------------

    const ANTHROPIC_API_URL: &str = "https://api.anthropic.com/v1/messages";
    const ANTHROPIC_VERSION: &str = "2023-06-01";
    // OAuth subscriptions may only have access to Haiku; override with
    // ANTHROPIC_TEST_MODEL env var to test other models if your plan allows.
    const DEFAULT_TEST_MODEL: &str = "claude-haiku-4-5-20251001";

    const ANTHROPIC_BETA_FLAGS: &str = "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,prompt-caching-scope-2026-01-05,advanced-tool-use-2025-11-20,effort-2025-11-24";

    fn live_headers() -> HashMap<String, String> {
        let access_token = std::env::var("ANTHROPIC_ACCESS_TOKEN")
            .expect("ANTHROPIC_ACCESS_TOKEN env var required");
        let session_id = uuid::Uuid::new_v4().to_string();
        let request_id = uuid::Uuid::new_v4().to_string();

        let mut headers = HashMap::new();
        headers.insert("Accept".to_string(), "application/json".to_string());
        headers.insert("Content-Type".to_string(), "application/json".to_string());
        headers.insert(
            "User-Agent".to_string(),
            "claude-cli/2.1.86 (external, cli)".to_string(),
        );
        headers.insert(
            "X-Claude-Code-Session-Id".to_string(),
            session_id,
        );
        headers.insert("X-Stainless-Arch".to_string(), std::env::consts::ARCH.to_string());
        headers.insert("X-Stainless-Lang".to_string(), "js".to_string());
        headers.insert("X-Stainless-OS".to_string(), std::env::consts::OS.to_string());
        headers.insert("X-Stainless-Package-Version".to_string(), "0.74.0".to_string());
        headers.insert("X-Stainless-Retry-Count".to_string(), "0".to_string());
        headers.insert("X-Stainless-Runtime".to_string(), "node".to_string());
        headers.insert("X-Stainless-Runtime-Version".to_string(), "v22.0.0".to_string());
        headers.insert("X-Stainless-Timeout".to_string(), "600".to_string());
        headers.insert(
            "anthropic-beta".to_string(),
            ANTHROPIC_BETA_FLAGS.to_string(),
        );
        headers.insert(
            "anthropic-dangerous-direct-browser-access".to_string(),
            "true".to_string(),
        );
        headers.insert(
            "anthropic-version".to_string(),
            ANTHROPIC_VERSION.to_string(),
        );
        headers.insert("x-app".to_string(), "cli".to_string());
        headers.insert("x-client-request-id".to_string(), request_id);
        headers.insert(
            "Authorization".to_string(),
            format!("Bearer {}", access_token),
        );
        headers
    }

    fn test_model() -> String {
        std::env::var("ANTHROPIC_TEST_MODEL").unwrap_or(DEFAULT_TEST_MODEL.to_string())
    }

    fn make_request(messages: Vec<serde_json::Value>) -> serde_json::Value {
        json!({
            "model": test_model(),
            "max_tokens": 1024,
            "stream": true,
            "messages": messages,
        })
    }

    fn user_message(text: &str) -> serde_json::Value {
        json!({
            "role": "user",
            "content": [{ "type": "text", "text": text }],
        })
    }

    /// Send a request, return (status, body).
    async fn send_request(
        url: &str,
        headers: &HashMap<String, String>,
        body: &serde_json::Value,
    ) -> (reqwest::StatusCode, String) {
        let client = reqwest::Client::new();
        let mut req = client.post(url).header("Accept", "text/event-stream");
        for (k, v) in headers {
            req = req.header(k, v);
        }
        let response = req
            .body(serde_json::to_string(body).expect("serialize"))
            .send()
            .await
            .expect("HTTP request failed");
        let status = response.status();
        let body = response.text().await.expect("read body");
        (status, body)
    }

    /// Parse a full streamed SSE body into a StreamResult.
    fn parse_sse_body(body: &str) -> super::super::StreamResult {
        let mut acc_text = String::new();
        let mut acc_reasoning = String::new();
        let mut usage = None;
        let mut stop_reason = String::from("unknown");
        let mut tool_uses: HashMap<usize, AnthropicToolUse> = HashMap::new();
        let mut events = Vec::new();

        for line in body.lines() {
            let trimmed = line.trim();
            if !trimmed.starts_with("data: ") {
                continue;
            }
            parse_anthropic_data(
                &trimmed[6..],
                &mut acc_text,
                &mut acc_reasoning,
                &mut usage,
                &mut stop_reason,
                &mut tool_uses,
                &mut events,
            );
        }

        let mut final_events = Vec::new();
        let tool_calls = finalize_anthropic_tools(tool_uses, &mut final_events);

        super::super::StreamResult {
            text: acc_text,
            reasoning: acc_reasoning,
            tool_calls,
            usage,
            stop_reason,
        }
    }

    // -----------------------------------------------------------------------
    // Live tests — require ANTHROPIC_ACCESS_TOKEN,
    // run via `python3 scripts/test.py anthropic`
    // -----------------------------------------------------------------------

    /// Minimal request — no thinking, no tools.
    /// Tests that OAuth auth + basic streaming works.
    #[tokio::test]
    #[ignore]
    async fn anthropic_live_hello_world() {
        let headers = live_headers();
        let request = make_request(vec![user_message("Say hello world")]);
        let url = format!("{}?beta=true", ANTHROPIC_API_URL);

        let (status, body) = send_request(&url, &headers, &request).await;
        assert!(
            status.is_success(),
            "Anthropic API returned {} — body: {}",
            status,
            &body[..body.len().min(500)]
        );

        let result = parse_sse_body(&body);
        assert_eq!(result.stop_reason, "stop");
        assert!(!result.text.is_empty(), "expected non-empty text response");
        assert!(result.usage.is_some(), "expected usage data");
    }

    /// Request with extended thinking (budget-based, works on all models).
    #[tokio::test]
    #[ignore]
    async fn anthropic_live_thinking() {
        let headers = live_headers();
        let mut request = make_request(vec![user_message("What is 2+2?")]);
        request["thinking"] = json!({ "type": "enabled", "budget_tokens": 2048 });
        let url = format!("{}?beta=true", ANTHROPIC_API_URL);

        let (status, body) = send_request(&url, &headers, &request).await;
        assert!(
            status.is_success(),
            "Thinking request returned {} — body: {}",
            status,
            &body[..body.len().min(500)]
        );

        let result = parse_sse_body(&body);
        assert_eq!(result.stop_reason, "stop");
        assert!(!result.text.is_empty(), "expected non-empty text response");
    }

    /// Tool call via OAuth.
    #[tokio::test]
    #[ignore]
    async fn anthropic_live_tool_call() {
        let headers = live_headers();
        let mut request = make_request(vec![user_message(
            "What is 7 + 13? Use the add_numbers tool.",
        )]);
        request["tools"] = json!([{
            "name": "add_numbers",
            "description": "Add two numbers together and return the result.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "a": { "type": "number", "description": "First number" },
                    "b": { "type": "number", "description": "Second number" },
                },
                "required": ["a", "b"],
            },
        }]);
        let url = format!("{}?beta=true", ANTHROPIC_API_URL);

        let (status, body) = send_request(&url, &headers, &request).await;
        assert!(
            status.is_success(),
            "Tool call request returned {} — body: {}",
            status,
            &body[..body.len().min(500)]
        );

        let result = parse_sse_body(&body);
        assert!(
            !result.tool_calls.is_empty(),
            "expected at least one tool call, got none"
        );
        let tc = &result.tool_calls[0];
        assert_eq!(tc.name, "add_numbers");

        let args = tc.args.as_object().expect("args should be a JSON object");
        assert!(args.contains_key("a"), "tool args missing 'a'");
        assert!(args.contains_key("b"), "tool args missing 'b'");
    }
}
