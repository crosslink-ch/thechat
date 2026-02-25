/**
 * Web Worker for SSE streaming.
 *
 * Receives fetch parameters from the main thread, performs the SSE fetch + parse,
 * and posts events back via postMessage. Text/reasoning/args deltas are batched
 * at ~60fps (16ms) to avoid flooding the main thread; structural events
 * (tool-call-start, tool-call-complete, error) are flushed immediately.
 */
import { parseOpenRouterSSE, parseCodexSSE } from "./sse-parse";
import type { StreamEvent } from "./types";

// Override self type for Worker context (this file only runs inside a Web Worker)
declare const self: {
  onmessage: ((e: MessageEvent) => void) | null;
  postMessage(message: unknown): void;
};

let controller: AbortController | null = null;

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data;

  if (msg.type === "cancel") {
    controller?.abort();
    return;
  }

  if (msg.type === "start") {
    controller = new AbortController();
    const { url, headers, body, provider } = msg as {
      url: string;
      headers: Record<string, string>;
      body: string;
      provider: "openrouter" | "codex";
    };

    // --- Batching state ---
    let eventQueue: StreamEvent[] = [];
    let flushTimer: ReturnType<typeof setTimeout> | null = null;

    function flush() {
      if (eventQueue.length > 0) {
        self.postMessage({ type: "events", events: eventQueue });
        eventQueue = [];
      }
      if (flushTimer !== null) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
    }

    function scheduleFlush() {
      if (flushTimer === null) {
        flushTimer = setTimeout(flush, 16);
      }
    }

    function onEvent(event: StreamEvent) {
      // Structural events: flush immediately (these change UI structure)
      if (event.type === "tool-call-start" || event.type === "tool-call-complete" || event.type === "error") {
        eventQueue.push(event);
        flush();
        return;
      }
      // Delta events: batch at ~60fps
      eventQueue.push(event);
      scheduleFlush();
    }

    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });

      if (!response.ok) {
        const errBody = await response.text();
        const label = provider === "codex" ? "Codex" : "OpenRouter";
        self.postMessage({ type: "error", error: `${label} API error (${response.status}): ${errBody}` });
        return;
      }

      const reader = response.body?.getReader();
      if (!reader) {
        self.postMessage({ type: "error", error: "No response body" });
        return;
      }

      const parser = provider === "codex" ? parseCodexSSE : parseOpenRouterSSE;
      const result = await parser(reader, onEvent);

      // Flush any remaining batched events before posting result
      flush();
      self.postMessage({ type: "result", result });
    } catch (err) {
      // Always flush pending events before signaling completion
      flush();
      if (err instanceof DOMException && err.name === "AbortError") {
        self.postMessage({ type: "aborted" });
      } else {
        self.postMessage({
          type: "error",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
};
