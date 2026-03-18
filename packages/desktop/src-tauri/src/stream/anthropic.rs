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
}
