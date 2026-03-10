import { invoke, Channel } from "@tauri-apps/api/core";
import { debug as logDebug } from "../log";
import type { ChatParams, StreamEvent, StreamResult, ToolDefinition } from "./types";
import { CODEX_MODELS, DEFAULT_REASONING_EFFORT } from "./models";

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
        content: [{ type: "input_text", text: msg.content as string }],
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
    stream: true,
    store: false,
  };

  try {
    logDebug(`[codex] Request body: ${JSON.stringify(truncate(bodyObj))}`);
  } catch {
    // ignore stringify errors
  }

  const reasoningEffort = params?.reasoning_effort ?? DEFAULT_REASONING_EFFORT;
  bodyObj.reasoning = { effort: reasoningEffort };

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
    "Content-Type": "application/json",
  };
  if (accountId) {
    headers["ChatGPT-Account-Id"] = accountId;
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
  } catch (e) {
    if (typeof e === "string" && e === "cancelled")
      throw new DOMException("Aborted", "AbortError");
    const msg = typeof e === "string" ? e : String(e);
    throw new Error(msg);
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
  }
}
