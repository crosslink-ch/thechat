import { invoke, Channel } from "@tauri-apps/api/core";
import type { ChatParams, StreamEvent, StreamResult, ToolDefinition } from "./types";
import { ANTHROPIC_MODELS, DEFAULT_REASONING_EFFORT, getMaxOutputTokens } from "./models";

export { ANTHROPIC_MODELS };

const ANTHROPIC_API_ENDPOINT = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

interface StreamAnthropicOptions {
  apiKey: string;
  model: string;
  messages: Array<Record<string, unknown>>;
  params?: ChatParams;
  tools?: ToolDefinition[];
  signal?: AbortSignal;
  onEvents: (events: StreamEvent[]) => void;
  /** If provided, use OAuth Bearer token instead of x-api-key. */
  oauthToken?: string;
}

/**
 * Convert OpenAI-style messages (used internally by the chat loop)
 * to Anthropic Messages API format.
 *
 * Input format (from chat loop):
 *   { role: "system", content: "..." }
 *   { role: "user", content: "..." }
 *   { role: "assistant", content: "text", tool_calls: [...] }
 *   { role: "tool", tool_call_id: "...", content: "..." }
 *
 * Output: { system, messages } in Anthropic format.
 */
function convertMessages(msgs: Array<Record<string, unknown>>): {
  system: Array<{ type: "text"; text: string }>;
  messages: Array<Record<string, unknown>>;
} {
  const system: Array<{ type: "text"; text: string }> = [];
  const anthropicMessages: Array<Record<string, unknown>> = [];

  for (const msg of msgs) {
    const role = msg.role as string;

    if (role === "system") {
      const text = (msg.content as string) ?? "";
      if (text) system.push({ type: "text", text });
      continue;
    }

    if (role === "user") {
      const content = [{ type: "text", text: msg.content as string }];
      // Merge with previous user message if needed (Anthropic requires alternating roles)
      const last = anthropicMessages[anthropicMessages.length - 1];
      if (last && last.role === "user") {
        (last.content as unknown[]).push(...content);
      } else {
        anthropicMessages.push({ role: "user", content });
      }
      continue;
    }

    if (role === "assistant") {
      const content: unknown[] = [];
      if (msg.content) {
        content.push({ type: "text", text: msg.content as string });
      }
      if (Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls as Array<Record<string, unknown>>) {
          const fn = tc.function as Record<string, unknown>;
          let input: unknown;
          try {
            input = typeof fn.arguments === "string" ? JSON.parse(fn.arguments as string) : fn.arguments;
          } catch {
            input = {};
          }
          content.push({
            type: "tool_use",
            id: tc.id as string,
            name: fn.name as string,
            input,
          });
        }
      }
      if (content.length > 0) {
        anthropicMessages.push({ role: "assistant", content });
      }
      continue;
    }

    if (role === "tool") {
      const toolResult = {
        type: "tool_result",
        tool_use_id: msg.tool_call_id as string,
        content: msg.content as string,
      };
      // Tool results must be in a user message. Merge consecutive tool results.
      const last = anthropicMessages[anthropicMessages.length - 1];
      if (last && last.role === "user") {
        (last.content as unknown[]).push(toolResult);
      } else {
        anthropicMessages.push({ role: "user", content: [toolResult] });
      }
      continue;
    }
  }

  return { system, messages: anthropicMessages };
}

/** Build the fetch request for Anthropic Messages API. */
async function buildRequest(options: StreamAnthropicOptions): Promise<{
  url: string;
  headers: Record<string, string>;
  body: string;
}> {
  const { apiKey, model, messages, params, tools, oauthToken } = options;
  const { system, messages: anthropicMessages } = convertMessages(messages);

  const bodyObj: Record<string, unknown> = {
    model: params?.model ?? model,
    messages: anthropicMessages,
    max_tokens: params?.max_tokens ?? await getMaxOutputTokens(params?.model ?? model),
    stream: true,
  };

  if (system.length > 0) {
    bodyObj.system = system;
  }

  if (params?.temperature !== undefined) bodyObj.temperature = params.temperature;
  if (params?.top_p !== undefined) bodyObj.top_p = params.top_p;
  if (params?.top_k !== undefined) bodyObj.top_k = params.top_k;
  if (params?.stop !== undefined) bodyObj.stop_sequences = params.stop;

  // Adaptive thinking (Claude 4.6+) — Anthropic supports up to "high"; clamp "xhigh" down.
  bodyObj.thinking = { type: "adaptive" };
  const rawEffort = params?.effort ?? DEFAULT_REASONING_EFFORT;
  bodyObj.output_config = { effort: rawEffort === "xhigh" ? "high" : rawEffort };

  // Add tool definitions in Anthropic format
  if (tools && tools.length > 0) {
    bodyObj.tools = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }));
  }

  // OAuth uses Bearer token + beta headers; API key uses x-api-key
  const headers: Record<string, string> = {
    "anthropic-version": ANTHROPIC_VERSION,
    "Content-Type": "application/json",
  };

  let url = ANTHROPIC_API_ENDPOINT;
  if (oauthToken) {
    headers["Authorization"] = `Bearer ${oauthToken}`;
    headers["anthropic-beta"] = "oauth-2025-04-20,interleaved-thinking-2025-05-14";
    url = `${ANTHROPIC_API_ENDPOINT}?beta=true`;
  } else {
    headers["x-api-key"] = apiKey;
  }

  return { url, headers, body: JSON.stringify(bodyObj) };
}

export async function streamAnthropicCompletion(options: StreamAnthropicOptions): Promise<StreamResult> {
  const req = await buildRequest(options);
  const streamId = `an_${Date.now()}_${Math.random().toString(36).slice(2)}`;

  const onEvent = new Channel<StreamEvent[]>();
  onEvent.onmessage = (batch) => {
    options.onEvents(batch);
  };

  const onAbort = () => {
    invoke("cancel_stream", { streamId }).catch(() => {});
  };
  options.signal?.addEventListener("abort", onAbort);

  try {
    return await invoke<StreamResult>("stream_completion", {
      url: req.url,
      headers: req.headers,
      body: req.body,
      provider: "anthropic",
      streamId,
      onEvent,
    });
  } catch (e) {
    if (typeof e === "string" && e === "cancelled")
      throw new DOMException("Aborted", "AbortError");
    const msg = typeof e === "string" ? e : String(e);
    throw new Error(msg);
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
  }
}
