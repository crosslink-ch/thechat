import { parseOpenRouterSSE } from "./sse-parse";
import { error as logError, warn as logWarn } from "../log";
import type { ChatParams, StreamEvent, StreamResult, ToolDefinition } from "./types";

interface StreamCompletionOptions {
  apiKey: string;
  model: string;
  messages: Array<Record<string, unknown>>;
  params?: ChatParams;
  tools?: ToolDefinition[];
  signal?: AbortSignal;
  onEvent: (event: StreamEvent) => void;
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
  if (params?.max_tokens !== undefined) bodyObj.max_tokens = params.max_tokens;
  if (params?.frequency_penalty !== undefined) bodyObj.frequency_penalty = params.frequency_penalty;
  if (params?.presence_penalty !== undefined) bodyObj.presence_penalty = params.presence_penalty;
  if (params?.stop !== undefined) bodyObj.stop = params.stop;
  if (params?.tool_choice !== undefined) bodyObj.tool_choice = params.tool_choice;
  if (params?.response_format !== undefined) bodyObj.response_format = params.response_format;
  if (params?.reasoning_effort !== undefined) bodyObj.reasoning_effort = params.reasoning_effort;
  if (params?.thinking !== undefined) bodyObj.thinking = params.thinking;
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

/** Try to create a stream Worker. Returns null if Workers aren't available (e.g. test env). */
function createStreamWorker(): Worker | null {
  if (typeof Worker === "undefined") return null;
  try {
    return new Worker(
      new URL("./stream-worker.ts", import.meta.url),
      { type: "module" },
    );
  } catch {
    return null;
  }
}

/** Stream via Web Worker — SSE parsing runs off the main thread. */
function streamViaWorker(
  worker: Worker,
  req: { url: string; headers: Record<string, string>; body: string },
  onEvent: (event: StreamEvent) => void,
  signal?: AbortSignal,
): Promise<StreamResult> {
  return new Promise((resolve, reject) => {
    const cleanup = () => worker.terminate();

    const onAbort = () => {
      worker.postMessage({ type: "cancel" });
    };
    signal?.addEventListener("abort", onAbort);

    worker.onmessage = (e: MessageEvent) => {
      const msg = e.data;
      if (msg.type === "events") {
        for (const event of msg.events) {
          onEvent(event);
        }
      } else if (msg.type === "result") {
        signal?.removeEventListener("abort", onAbort);
        cleanup();
        resolve(msg.result as StreamResult);
      } else if (msg.type === "error") {
        signal?.removeEventListener("abort", onAbort);
        cleanup();
        logError(`[openrouter] ${msg.error}`);
        reject(new Error(msg.error));
      } else if (msg.type === "aborted") {
        signal?.removeEventListener("abort", onAbort);
        cleanup();
        reject(new DOMException("Aborted", "AbortError"));
      }
    };

    worker.onerror = (err) => {
      signal?.removeEventListener("abort", onAbort);
      cleanup();
      reject(new Error(err.message || "Worker error"));
    };

    worker.postMessage({
      type: "start",
      provider: "openrouter",
      url: req.url,
      headers: req.headers,
      body: req.body,
    });
  });
}

/** Fallback: stream directly on the main thread (used when Worker is unavailable). */
async function streamDirect(
  req: { url: string; headers: Record<string, string>; body: string },
  onEvent: (event: StreamEvent) => void,
  signal?: AbortSignal,
): Promise<StreamResult> {
  const response = await fetch(req.url, {
    method: "POST",
    headers: req.headers,
    body: req.body,
    signal,
  });

  if (!response.ok) {
    const errBody = await response.text();
    logError(`[openrouter] API error ${response.status}: ${errBody}`);
    throw new Error(`OpenRouter API error (${response.status}): ${errBody}`);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error("No response body");

  return parseOpenRouterSSE(reader, onEvent);
}

export async function streamCompletion(options: StreamCompletionOptions): Promise<StreamResult> {
  const req = buildRequest(options);

  const worker = createStreamWorker();
  if (worker) {
    try {
      return await streamViaWorker(worker, req, options.onEvent, options.signal);
    } catch (e) {
      // Re-throw abort errors as-is
      if (e instanceof DOMException && e.name === "AbortError") throw e;
      // Re-throw API errors (Worker successfully ran but API returned error)
      if (e instanceof Error && !e.message.includes("Worker")) throw e;
      // Worker failed to initialize/run — fall back to direct streaming
      logWarn(`[openrouter] Worker failed, falling back to direct streaming`);
      return streamDirect(req, options.onEvent, options.signal);
    }
  }

  return streamDirect(req, options.onEvent, options.signal);
}
