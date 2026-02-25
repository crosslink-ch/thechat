import type { StreamEvent, StreamResult } from "./types";

/**
 * Parse OpenRouter SSE stream (Chat Completions format) and emit events.
 * Pure parsing logic — no Worker, Tauri, or logging dependencies.
 */
export async function parseOpenRouterSSE(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onEvent: (event: StreamEvent) => void,
): Promise<StreamResult> {
  const decoder = new TextDecoder();
  let buffer = "";
  let accText = "";
  let accReasoning = "";
  let usage: StreamResult["usage"] = undefined;

  // Tool call accumulation: indexed by tool call index within the response
  const toolCallAccum: Map<number, { id: string; name: string; args: string }> = new Map();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data: ")) continue;

      const data = trimmed.slice(6);
      if (data === "[DONE]") continue;

      try {
        const parsed = JSON.parse(data);

        // Parse usage from final chunk
        if (parsed.usage) {
          usage = {
            prompt_tokens: parsed.usage.prompt_tokens,
            completion_tokens: parsed.usage.completion_tokens,
            total_tokens: parsed.usage.total_tokens,
          };
        }

        const delta = parsed.choices?.[0]?.delta;
        if (!delta) continue;

        // Reasoning content
        if (delta.reasoning) {
          accReasoning += delta.reasoning;
          onEvent({ type: "reasoning-delta", text: delta.reasoning });
        }
        if (delta.reasoning_details) {
          for (const detail of delta.reasoning_details) {
            if (detail.type === "thinking" && detail.thinking) {
              accReasoning += detail.thinking;
              onEvent({ type: "reasoning-delta", text: detail.thinking });
            }
          }
        }

        // Text content
        if (delta.content) {
          accText += delta.content;
          onEvent({ type: "text-delta", text: delta.content });
        }

        // Tool calls
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            let accum = toolCallAccum.get(idx);

            if (!accum) {
              accum = { id: tc.id || "", name: tc.function?.name || "", args: "" };
              toolCallAccum.set(idx, accum);
            }

            if (tc.id) accum.id = tc.id;
            if (tc.function?.name) {
              accum.name = tc.function.name;
              onEvent({ type: "tool-call-start", toolCallId: accum.id, toolName: accum.name });
            }
            if (tc.function?.arguments) {
              accum.args += tc.function.arguments;
              onEvent({ type: "tool-call-args-delta", toolCallId: accum.id, args: tc.function.arguments });
            }
          }
        }
      } catch {
        console.warn(`[sse-parse] Skipping malformed SSE chunk: ${data.slice(0, 200)}`);
      }
    }
  }

  // Emit tool-call-complete events for all accumulated tool calls
  const toolCalls = Array.from(toolCallAccum.values()).map((tc) => {
    let parsedArgs: Record<string, unknown> = {};
    try {
      parsedArgs = JSON.parse(tc.args);
    } catch {
      console.warn(`[sse-parse] Failed to parse tool args for ${tc.name}: ${tc.args.slice(0, 200)}`);
    }
    onEvent({
      type: "tool-call-complete",
      toolCallId: tc.id,
      toolName: tc.name,
      args: parsedArgs,
    });
    return { id: tc.id, name: tc.name, args: parsedArgs };
  });

  return { text: accText, reasoning: accReasoning, toolCalls, usage };
}

/**
 * Parse Codex (Responses API) SSE stream and emit events.
 * Pure parsing logic — no Worker, Tauri, or logging dependencies.
 */
export async function parseCodexSSE(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onEvent: (event: StreamEvent) => void,
): Promise<StreamResult> {
  const decoder = new TextDecoder();
  let buffer = "";
  let accText = "";
  let accReasoning = "";
  let usage: StreamResult["usage"] = undefined;

  // Track function calls by item_id
  const funcCalls: Map<string, { id: string; callId: string; name: string; args: string }> = new Map();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data: ")) continue;

      const data = trimmed.slice(6);
      if (data === "[DONE]") continue;

      try {
        const event = JSON.parse(data);
        const type = event.type as string;

        if (type === "response.output_text.delta") {
          const delta = event.delta as string;
          accText += delta;
          onEvent({ type: "text-delta", text: delta });
        } else if (type === "response.reasoning_summary_text.delta") {
          const delta = event.delta as string;
          accReasoning += delta;
          onEvent({ type: "reasoning-delta", text: delta });
        } else if (type === "response.output_item.added") {
          const item = event.item as Record<string, unknown>;
          if (item.type === "function_call") {
            const itemId = item.id as string;
            const callId = (item.call_id as string) || itemId;
            const name = (item.name as string) || "";
            funcCalls.set(itemId, { id: itemId, callId, name, args: "" });
            if (name) {
              onEvent({ type: "tool-call-start", toolCallId: callId, toolName: name });
            }
          }
        } else if (type === "response.function_call_arguments.delta") {
          const itemId = event.item_id as string;
          const delta = event.delta as string;
          const fc = funcCalls.get(itemId);
          if (fc) {
            fc.args += delta;
            onEvent({ type: "tool-call-args-delta", toolCallId: fc.callId, args: delta });
          }
        } else if (type === "response.output_item.done") {
          const item = event.item as Record<string, unknown>;
          if (item.type === "function_call") {
            const itemId = item.id as string;
            const fc = funcCalls.get(itemId);
            if (fc) {
              // Use completed arguments from the item
              fc.args = (item.arguments as string) || fc.args;
            }
          }
        } else if (type === "response.completed" || type === "response.incomplete") {
          const resp = event.response as Record<string, unknown> | undefined;
          const u = resp?.usage as Record<string, unknown> | undefined;
          if (u) {
            const inputTokens = (u.input_tokens as number) || 0;
            const outputTokens = (u.output_tokens as number) || 0;
            usage = {
              prompt_tokens: inputTokens,
              completion_tokens: outputTokens,
              total_tokens: inputTokens + outputTokens,
            };
          }
        } else if (type === "error") {
          const msg = (event.message as string) || "Unknown Codex API error";
          onEvent({ type: "error", error: msg });
        }
      } catch {
        console.warn(`[sse-parse] Skipping malformed SSE chunk: ${data.slice(0, 200)}`);
      }
    }
  }

  // Emit tool-call-complete events for all accumulated function calls
  const toolCalls = Array.from(funcCalls.values()).map((fc) => {
    let parsedArgs: Record<string, unknown> = {};
    try {
      parsedArgs = JSON.parse(fc.args);
    } catch {
      console.warn(`[sse-parse] Failed to parse tool args for ${fc.name}: ${fc.args.slice(0, 200)}`);
    }
    onEvent({
      type: "tool-call-complete",
      toolCallId: fc.callId,
      toolName: fc.name,
      args: parsedArgs,
    });
    return { id: fc.callId, name: fc.name, args: parsedArgs };
  });

  return { text: accText, reasoning: accReasoning, toolCalls, usage };
}
