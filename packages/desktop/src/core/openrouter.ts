import { invoke, Channel } from "@tauri-apps/api/core";
import type { ChatParams, StreamEvent, StreamResult, ToolDefinition } from "./types";
import { getMaxOutputTokens } from "./models";

interface StreamCompletionOptions {
  apiKey: string;
  model: string;
  messages: Array<Record<string, unknown>>;
  params?: ChatParams;
  tools?: ToolDefinition[];
  signal?: AbortSignal;
  onEvents: (events: StreamEvent[]) => void;
}

/** Build the fetch request for OpenRouter Chat Completions API. */
function buildRequest(options: StreamCompletionOptions): {
  url: string;
  headers: Record<string, string>;
  body: string;
} {
  const { apiKey, model, messages, params, tools } = options;

  const bodyObj: Record<string, unknown> = {
    model: params?.model ?? model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };

  // Pass through optional params
  if (params?.temperature !== undefined) bodyObj.temperature = params.temperature;
  if (params?.top_p !== undefined) bodyObj.top_p = params.top_p;
  if (params?.top_k !== undefined) bodyObj.top_k = params.top_k;
  bodyObj.max_tokens = params?.max_tokens ?? getMaxOutputTokens(params?.model ?? model);
  if (params?.frequency_penalty !== undefined) bodyObj.frequency_penalty = params.frequency_penalty;
  if (params?.presence_penalty !== undefined) bodyObj.presence_penalty = params.presence_penalty;
  if (params?.stop !== undefined) bodyObj.stop = params.stop;
  if (params?.tool_choice !== undefined) bodyObj.tool_choice = params.tool_choice;
  if (params?.response_format !== undefined) bodyObj.response_format = params.response_format;
  if (params?.reasoning_effort !== undefined) bodyObj.reasoning_effort = params.reasoning_effort;
  if (params?.seed !== undefined) bodyObj.seed = params.seed;
  if (params?.provider !== undefined) bodyObj.provider = params.provider;

  // Add tool definitions if provided
  if (tools && tools.length > 0) {
    bodyObj.tools = tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
  }

  return {
    url: "https://openrouter.ai/api/v1/chat/completions",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(bodyObj),
  };
}

export async function streamCompletion(options: StreamCompletionOptions): Promise<StreamResult> {
  const req = buildRequest(options);
  const streamId = `or_${Date.now()}_${Math.random().toString(36).slice(2)}`;

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
      provider: "openrouter",
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
