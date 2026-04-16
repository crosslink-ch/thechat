/**
 * Generic OpenAI-compatible Chat Completions streaming client.
 *
 * Shared by both OpenRouter and GLM providers — they use the same
 * request/response format, just different base URLs and API keys.
 */

import { invoke, Channel } from "@tauri-apps/api/core";
import type { ChatParams, StreamEvent, StreamResult, ToolDefinition } from "./types";
import { getMaxOutputTokens } from "./models";
import { ProviderError, type Provider } from "./errors";

export interface ChatCompletionsOptions {
  url: string;
  apiKey: string;
  model: string;
  messages: Array<Record<string, unknown>>;
  params?: ChatParams;
  tools?: ToolDefinition[];
  signal?: AbortSignal;
  onEvents: (events: StreamEvent[]) => void;
  /** Provider tag passed to the Rust streaming layer (e.g. "openrouter", "glm"). */
  providerTag: Provider;
  /** Prefix for stream IDs (e.g. "or_", "glm_"). */
  streamIdPrefix: string;
}

/** Build the fetch request body and headers for a Chat Completions API call. */
async function buildRequest(options: ChatCompletionsOptions): Promise<{
  url: string;
  headers: Record<string, string>;
  body: string;
}> {
  const { url, apiKey, model, messages, params, tools } = options;

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
  bodyObj.max_tokens = params?.max_tokens ?? await getMaxOutputTokens(params?.model ?? model);
  // Featherless rejects max_tokens above 32_768
  if (options.providerTag === "featherless" && typeof bodyObj.max_tokens === "number" && bodyObj.max_tokens > 32_768) {
    bodyObj.max_tokens = 32_768;
  }
  if (params?.frequency_penalty !== undefined) bodyObj.frequency_penalty = params.frequency_penalty;
  if (params?.presence_penalty !== undefined) bodyObj.presence_penalty = params.presence_penalty;
  if (params?.stop !== undefined) bodyObj.stop = params.stop;
  if (params?.tool_choice !== undefined) bodyObj.tool_choice = params.tool_choice;
  if (params?.response_format !== undefined) bodyObj.response_format = params.response_format;
  // GLM uses a binary `thinking` param; other providers use `reasoning_effort`
  if (options.providerTag === "glm") {
    bodyObj.thinking = { type: "enabled" };
  } else {
    if (params?.reasoning_effort !== undefined) bodyObj.reasoning_effort = params.reasoning_effort;
  }
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
    url,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(bodyObj),
  };
}

/**
 * Stream a Chat Completions request through the Tauri backend.
 * Used by both OpenRouter and GLM providers.
 */
export async function streamChatCompletion(options: ChatCompletionsOptions): Promise<StreamResult> {
  const req = await buildRequest(options);
  const streamId = `${options.streamIdPrefix}${Date.now()}_${Math.random().toString(36).slice(2)}`;

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
      provider: options.providerTag,
      streamId,
      onEvent,
    });
  } catch (e: any) {
    const msg = e?.message ?? (typeof e === "string" ? e : String(e));
    if (msg === "cancelled") throw new DOMException("Aborted", "AbortError");
    throw new ProviderError(msg, options.providerTag, e?.statusCode);
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
  }
}
