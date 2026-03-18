use std::collections::HashMap;

use super::{StreamEvent, ToolCallResult, Usage};

pub(super) struct ToolCallAccum {
    pub id: String,
    pub name: String,
    pub args: String,
}

pub(super) fn parse_openrouter_data(
    data: &str,
    acc_text: &mut String,
    acc_reasoning: &mut String,
    usage: &mut Option<Usage>,
    stop_reason: &mut String,
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

    // Finish reason: normalize OpenAI-style values
    if let Some(reason) = parsed
        .pointer("/choices/0/finish_reason")
        .and_then(|v| v.as_str())
    {
        *stop_reason = match reason {
            "stop" => "stop".to_string(),
            "tool_calls" => "tool_calls".to_string(),
            "length" | "max_tokens" => "length".to_string(),
            "content_filter" => "content_filter".to_string(),
            other => other.to_string(),
        };
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

/// Finalize accumulated tool calls into `ToolCallComplete` events and `ToolCallResult`s.
pub(super) fn finalize_openrouter_tools(
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

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_or(
        data: &str,
    ) -> (
        String,
        String,
        Option<Usage>,
        HashMap<usize, ToolCallAccum>,
        Vec<StreamEvent>,
    ) {
        let mut text = String::new();
        let mut reasoning = String::new();
        let mut usage = None;
        let mut stop_reason = String::from("unknown");
        let mut tool_calls = HashMap::new();
        let mut events = Vec::new();
        parse_openrouter_data(
            data,
            &mut text,
            &mut reasoning,
            &mut usage,
            &mut stop_reason,
            &mut tool_calls,
            &mut events,
        );
        (text, reasoning, usage, tool_calls, events)
    }

    #[test]
    fn test_parse_openrouter_text_delta() {
        let (text, _, _, _, events) = parse_or(r#"{"choices":[{"delta":{"content":"Hello"}}]}"#);
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
        let mut stop_reason = String::from("unknown");
        let mut tool_calls: HashMap<usize, ToolCallAccum> = HashMap::new();
        let mut events = Vec::new();

        // First chunk: tool call start
        parse_openrouter_data(
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"get_weather","arguments":""}}]}}]}"#,
            &mut text,
            &mut reasoning,
            &mut usage,
            &mut stop_reason,
            &mut tool_calls,
            &mut events,
        );
        // Second chunk: args delta
        parse_openrouter_data(
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"city\""}}]}}]}"#,
            &mut text,
            &mut reasoning,
            &mut usage,
            &mut stop_reason,
            &mut tool_calls,
            &mut events,
        );
        // Third chunk: more args
        parse_openrouter_data(
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":": \"Paris\"}"}}]}}]}"#,
            &mut text,
            &mut reasoning,
            &mut usage,
            &mut stop_reason,
            &mut tool_calls,
            &mut events,
        );

        assert_eq!(tool_calls.len(), 1);
        let tc = tool_calls.get(&0).unwrap();
        assert_eq!(tc.id, "call_1");
        assert_eq!(tc.name, "get_weather");
        assert_eq!(tc.args, r#"{"city": "Paris"}"#);

        // Should have: start, args-delta (empty), args-delta, args-delta
        assert!(events
            .iter()
            .any(|e| matches!(e, StreamEvent::ToolCallStart { .. })));
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
}
