import { invoke, Channel } from "@tauri-apps/api/core";
import type { ChatParams, StreamEvent, StreamResult, ToolDefinition } from "./types";
import { ANTHROPIC_MODELS, DEFAULT_REASONING_EFFORT, getMaxOutputTokens } from "./models";
import { ProviderError } from "./errors";

export { ANTHROPIC_MODELS };

const ANTHROPIC_API_ENDPOINT = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

// Session ID persists for the lifetime of the app (like Claude Code does)
const SESSION_ID = crypto.randomUUID();

const ANTHROPIC_BETA_FLAGS = [
  "claude-code-20250219",
  "oauth-2025-04-20",
  "context-1m-2025-08-07",
  "interleaved-thinking-2025-05-14",
  "redact-thinking-2026-02-12",
  "context-management-2025-06-27",
  "prompt-caching-scope-2026-01-05",
  "advanced-tool-use-2025-11-20",
  "effort-2025-11-24",
].join(",");

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
 * Convert user message content (string or OpenAI content array)
 * to Anthropic content blocks.
 */
function convertUserContent(content: unknown): unknown[] {
  // Plain string
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }

  // Content array (OpenAI format with image_url parts)
  if (Array.isArray(content)) {
    return content.map((part: Record<string, unknown>) => {
      if (part.type === "text") {
        return { type: "text", text: part.text as string };
      }
      if (part.type === "image_url") {
        const imageUrl = part.image_url as { url: string };
        const url = imageUrl.url;
        // Parse data URI: data:<mime>;base64,<data>
        const match = url.match(/^data:([^;]+);base64,(.+)$/s);
        if (match) {
          return {
            type: "image",
            source: {
              type: "base64",
              media_type: match[1],
              data: match[2],
            },
          };
        }
        // URL-based image
        return {
          type: "image",
          source: { type: "url", url },
        };
      }
      // Pass through unknown parts as-is
      return part;
    });
  }

  return [{ type: "text", text: String(content) }];
}

/**
 * Convert OpenAI-style messages (used internally by the chat loop)
 * to Anthropic Messages API format.
 *
 * Input format (from chat loop):
 *   { role: "system", content: "..." }
 *   { role: "user", content: "..." | [{ type: "text", ... }, { type: "image_url", ... }] }
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
      const content = convertUserContent(msg.content);
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

  // Build headers matching Claude Code's request format
  const headers: Record<string, string> = {
    "Accept": "application/json",
    "Content-Type": "application/json",
    "User-Agent": "claude-cli/2.1.86 (external, cli)",
    "X-Claude-Code-Session-Id": SESSION_ID,
    "X-Stainless-Arch": navigator.userAgent.includes("x86_64") || navigator.userAgent.includes("x64") ? "x64" : "arm64",
    "X-Stainless-Lang": "js",
    "X-Stainless-OS": navigator.userAgent.includes("Windows") ? "Windows" : navigator.userAgent.includes("Mac") ? "macOS" : "Linux",
    "X-Stainless-Package-Version": "0.74.0",
    "X-Stainless-Retry-Count": "0",
    "X-Stainless-Runtime": "node",
    "X-Stainless-Runtime-Version": "v22.0.0",
    "X-Stainless-Timeout": "600",
    "anthropic-beta": ANTHROPIC_BETA_FLAGS,
    "anthropic-dangerous-direct-browser-access": "true",
    "anthropic-version": ANTHROPIC_VERSION,
    "x-app": "cli",
    "x-client-request-id": crypto.randomUUID(),
  };

  let url = ANTHROPIC_API_ENDPOINT;
  if (oauthToken) {
    headers["Authorization"] = `Bearer ${oauthToken}`;
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
  } catch (e: any) {
    const msg = e?.message ?? (typeof e === "string" ? e : String(e));
    if (msg === "cancelled") throw new DOMException("Aborted", "AbortError");
    throw new ProviderError(msg, "anthropic", e?.statusCode);
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
  }
}
