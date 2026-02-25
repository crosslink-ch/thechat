import { fetch } from "@tauri-apps/plugin-http";
import { error as logError, warn as logWarn } from "../log";
import type { ChatParams, StreamEvent, StreamResult, ToolDefinition } from "./types";

const CODEX_API_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";

export const CODEX_MODELS = [
  { id: "gpt-5.3-codex", name: "GPT-5.3 Codex" },
  { id: "gpt-5.2-codex", name: "GPT-5.2 Codex" },
  { id: "gpt-5.2", name: "GPT-5.2" },
  { id: "gpt-5.1-codex-max", name: "GPT-5.1 Codex Max" },
  { id: "gpt-5.1-codex-mini", name: "GPT-5.1 Codex Mini" },
  { id: "gpt-5.1-codex", name: "GPT-5.1 Codex" },
];

interface StreamCodexOptions {
  accessToken: string;
  accountId: string;
  model: string;
  messages: Array<Record<string, unknown>>;
  params?: ChatParams;
  tools?: ToolDefinition[];
  signal?: AbortSignal;
  onEvent: (event: StreamEvent) => void;
}

/**
 * Convert Chat Completions messages to Responses API input format.
 */
function messagesToResponsesInput(messages: Array<Record<string, unknown>>): unknown[] {
  const input: unknown[] = [];

  for (const msg of messages) {
    const role = msg.role as string;

    if (role === "system") {
      input.push({
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: msg.content as string }],
      });
    } else if (role === "user") {
      input.push({
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: msg.content as string }],
      });
    } else if (role === "assistant") {
      // Assistant message might have text content and/or tool_calls
      const parts: unknown[] = [];
      if (msg.content) {
        parts.push({ type: "output_text", text: msg.content as string });
      }
      if (Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls as Array<Record<string, unknown>>) {
          const fn = tc.function as Record<string, unknown>;
          input.push({
            type: "function_call",
            id: tc.id,
            call_id: tc.id,
            name: fn.name,
            arguments: fn.arguments as string,
          });
        }
      }
      if (parts.length > 0) {
        input.push({ type: "message", role: "assistant", content: parts });
      }
    } else if (role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: msg.tool_call_id as string,
        output: msg.content as string,
      });
    }
  }

  return input;
}

export async function streamCodexCompletion(options: StreamCodexOptions): Promise<StreamResult> {
  const { accessToken, accountId, model, messages, params, tools, signal, onEvent } = options;

  const body: Record<string, unknown> = {
    model: params?.model ?? model,
    input: messagesToResponsesInput(messages),
    stream: true,
  };

  if (params?.max_tokens !== undefined) body.max_output_tokens = params.max_tokens;

  // Add tools in Responses API format
  if (tools && tools.length > 0) {
    body.tools = tools.map((t) => ({
      type: "function",
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
  };
  if (accountId) {
    headers["ChatGPT-Account-Id"] = accountId;
  }

  const response = await fetch(CODEX_API_ENDPOINT, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const errBody = await response.text();
    logError(`[codex] API error ${response.status}: ${errBody}`);
    throw new Error(`Codex API error (${response.status}): ${errBody}`);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error("No response body");

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
          logError(`[codex] Stream error: ${msg}`);
          onEvent({ type: "error", error: msg });
        }
      } catch (e) {
        logWarn(`[codex] Skipping malformed SSE chunk: ${data.slice(0, 200)}`);
      }
    }
  }

  // Emit tool-call-complete events for all accumulated function calls
  const toolCalls = Array.from(funcCalls.values()).map((fc) => {
    let parsedArgs: Record<string, unknown> = {};
    try {
      parsedArgs = JSON.parse(fc.args);
    } catch {
      logWarn(`[codex] Failed to parse tool args for ${fc.name}: ${fc.args.slice(0, 200)}`);
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
