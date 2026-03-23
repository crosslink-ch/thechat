import { invoke, Channel } from "@tauri-apps/api/core";
import { debug as logDebug } from "../log";
import type { ChatParams, StreamEvent, StreamResult, ToolDefinition } from "./types";
import { CODEX_MODELS, DEFAULT_REASONING_EFFORT } from "./models";
import { ProviderError } from "./errors";

export { CODEX_MODELS };

const CODEX_API_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";

function truncate(value: unknown, max = 2000): unknown {
  if (typeof value === "string" && value.length > max) return value.slice(0, max) + `…(+${value.length - max})`;
  if (Array.isArray(value)) return value.map((v) => truncate(v, max));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = truncate(v, max);
    return out;
  }
  return value;
}

function buildTextControls(params?: ChatParams): Record<string, unknown> | undefined {
  const verbosity = params?.verbosity;
  const responseFormat = params?.response_format;
  if (!verbosity && !responseFormat) return undefined;

  const text: Record<string, unknown> = {};
  if (verbosity) {
    text.verbosity = verbosity;
  }

  if (responseFormat?.type === "json_schema") {
    text.format = {
      type: "json_schema",
      name: responseFormat.json_schema.name,
      strict: responseFormat.json_schema.strict ?? true,
      schema: responseFormat.json_schema.schema,
    };
  }

  return text;
}


interface StreamCodexOptions {
  accessToken: string;
  accountId: string;
  model: string;
  messages: Array<Record<string, unknown>>;
  params?: ChatParams;
  tools?: ToolDefinition[];
  signal?: AbortSignal;
  onEvents: (events: StreamEvent[]) => void;
  convId?: string;
  turnId?: string;
}

/**
 * Convert user message content (string or OpenAI content array)
 * to Codex Responses API content blocks.
 */
function convertUserContentToCodex(content: unknown): unknown[] {
  // Plain string
  if (typeof content === "string") {
    return [{ type: "input_text", text: content }];
  }

  // Content array (OpenAI format)
  if (Array.isArray(content)) {
    return content.map((part: Record<string, unknown>) => {
      if (part.type === "text") {
        return { type: "input_text", text: part.text as string };
      }
      if (part.type === "image_url") {
        const imageUrl = part.image_url as { url: string };
        return { type: "input_image", image_url: imageUrl.url };
      }
      return part;
    });
  }

  return [{ type: "input_text", text: String(content) }];
}

/**
 * Convert Chat Completions messages to Responses API input format.
 */
function messagesToResponsesInput(messages: Array<Record<string, unknown>>): unknown[] {
  const input: unknown[] = [];

  const normalizeFcId = (raw: unknown): string => {
    const s = String(raw ?? "");
    if (!s) return "fc_" + Math.random().toString(36).slice(2);
    if (s.startsWith("fc")) return s;
    const core = s.replace(/^(call[_-]?)/, "");
    return "fc_" + core;
  };

  for (const msg of messages) {
    const role = msg.role as string;

    if (role === "user") {
      input.push({
        type: "message",
        role: "user",
        content: convertUserContentToCodex(msg.content),
      });
    } else if (role === "assistant") {
      // Assistant message might have text content and/or tool_calls.
      if (msg.content) {
        input.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: msg.content as string }] });
      }
      if (Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls as Array<Record<string, unknown>>) {
          const fn = tc.function as Record<string, unknown>;
          const id = normalizeFcId(tc.id);
          input.push({
            type: "function_call",
            id,
            call_id: id,
            name: fn.name,
            arguments: fn.arguments as string,
          });
        }
      }
    } else if (role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: normalizeFcId(msg.tool_call_id as string),
        output: msg.content as string,
      });
    }
  }

  return input;
}

/** Build the fetch request for Codex Responses API. */
function buildRequest(options: StreamCodexOptions): {
  url: string;
  headers: Record<string, string>;
  body: string;
} {
  const { accessToken, accountId, model, messages, params, tools } = options;

  let instructions = "";
  const nonSystemMessages: Array<Record<string, unknown>> = [];
  for (const m of messages) {
    if ((m.role as string) === "system") {
      const c = (m.content as string) ?? "";
      if (c) instructions = instructions ? `${instructions}\n\n${c}` : c;
    } else {
      nonSystemMessages.push(m);
    }
  }

  const bodyObj: Record<string, unknown> = {
    model: params?.model ?? model,
    instructions,
    input: messagesToResponsesInput(nonSystemMessages),
    tool_choice: "auto",
    parallel_tool_calls: true,
    stream: true,
    store: false,
    include: ["reasoning.encrypted_content"],
  };

  try {
    logDebug(`[codex] Request body: ${JSON.stringify(truncate(bodyObj))}`);
  } catch {
    // ignore stringify errors
  }

  const reasoningEffort = params?.reasoning_effort ?? DEFAULT_REASONING_EFFORT;
  bodyObj.reasoning = { effort: reasoningEffort };
  if (options.convId) bodyObj.prompt_cache_key = options.convId;
  if (params?.service_tier) bodyObj.service_tier = params.service_tier;
  const text = buildTextControls(params);
  if (text) bodyObj.text = text;

  // Add tools in Responses API format
  if (tools && tools.length > 0) {
    bodyObj.tools = tools.map((t) => ({
      type: "function",
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "text/event-stream",
    "Content-Type": "application/json",
  };
  if (accountId) {
    headers["ChatGPT-Account-Id"] = accountId;
  }
  if (options.convId) {
    headers["x-client-request-id"] = options.convId;
    headers["session_id"] = options.convId;
  }
  if (options.turnId) {
    headers["x-codex-turn-metadata"] = JSON.stringify({ turn_id: options.turnId });
  }

  return {
    url: CODEX_API_ENDPOINT,
    headers,
    body: JSON.stringify(bodyObj),
  };
}

export async function streamCodexCompletion(options: StreamCodexOptions): Promise<StreamResult> {
  const req = buildRequest(options);
  const streamId = `cx_${Date.now()}_${Math.random().toString(36).slice(2)}`;

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
      provider: "codex",
      streamId,
      onEvent,
    });
  } catch (e: any) {
    const msg = e?.message ?? (typeof e === "string" ? e : String(e));
    if (msg === "cancelled") throw new DOMException("Aborted", "AbortError");
    throw new ProviderError(msg, "codex", e?.statusCode);
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
  }
}
