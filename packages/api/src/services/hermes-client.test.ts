import { describe, test, expect, afterEach } from "bun:test";
import {
  getHermesCapabilities,
  getHermesHealth,
  startHermesRun,
  stopHermesRun,
  streamHermesRunEvents,
} from "./hermes-client";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function jsonResponse(body: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
}

describe("Hermes client", () => {
  test("normalizes root and /v1 base URLs and adds bearer auth", async () => {
    const calls: Array<{ url: string; authorization: string | null }> = [];
    globalThis.fetch = (async (input, init) => {
      const headers = new Headers(init?.headers as HeadersInit);
      calls.push({ url: String(input), authorization: headers.get("authorization") });
      return jsonResponse({ capabilities: ["runs"] });
    }) as typeof fetch;

    await getHermesCapabilities({ baseUrl: "http://localhost:18642", apiKey: "secret" });
    await getHermesCapabilities({ baseUrl: "http://localhost:18642/v1/", apiKey: "secret" });

    expect(calls).toEqual([
      { url: "http://localhost:18642/v1/capabilities", authorization: "Bearer secret" },
      { url: "http://localhost:18642/v1/capabilities", authorization: "Bearer secret" },
    ]);
  });

  test("checks root health endpoint", async () => {
    let calledUrl = "";
    globalThis.fetch = (async (input, init) => {
      calledUrl = String(input);
      const headers = new Headers(init?.headers as HeadersInit);
      expect(headers.get("authorization")).toBe("Bearer secret");
      return jsonResponse({ status: "ok" });
    }) as typeof fetch;

    const health = await getHermesHealth({ baseUrl: "http://localhost:18642/v1", apiKey: "secret" });

    expect(calledUrl).toBe("http://localhost:18642/health");
    expect(health).toEqual({ status: "ok" });
  });

  test("starts and stops runs through /v1/runs", async () => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    globalThis.fetch = (async (input, init) => {
      calls.push({
        url: String(input),
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (String(input).endsWith("/stop")) return jsonResponse({ status: "cancelled" });
      return jsonResponse({ run_id: "run-123", status: "queued" });
    }) as typeof fetch;

    const run = await startHermesRun(
      { baseUrl: "http://localhost:18642", apiKey: "secret" },
      { input: "hello", session_id: "thechat:session", instructions: "Be concise" },
    );
    const stopped = await stopHermesRun({ baseUrl: "http://localhost:18642", apiKey: "secret" }, "run-123");

    expect(run.run_id).toBe("run-123");
    expect(stopped.status).toBe("cancelled");
    expect(calls).toEqual([
      {
        url: "http://localhost:18642/v1/runs",
        method: "POST",
        body: { input: "hello", session_id: "thechat:session", instructions: "Be concise" },
      },
      { url: "http://localhost:18642/v1/runs/run-123/stop", method: "POST", body: undefined },
    ]);
  });

  test("parses server-sent run events", async () => {
    const sse = [
      "event: run_started",
      'data: {"run_id":"run-123"}',
      "",
      'data: {"type":"token","text":"hi"}',
      "",
      "event: done",
      'data: {"final_output":"hello"}',
      "",
    ].join("\n");
    globalThis.fetch = (async () => new Response(sse, { status: 200 })) as unknown as typeof fetch;

    const events: Array<{ type: string; payload: unknown }> = [];
    await streamHermesRunEvents(
      { baseUrl: "http://localhost:18642", apiKey: "secret" },
      "run-123",
      (event) => {
        events.push(event);
      },
    );

    expect(events).toEqual([
      { type: "run_started", payload: { run_id: "run-123" } },
      { type: "message", payload: { type: "token", text: "hi" } },
      { type: "done", payload: { final_output: "hello" } },
    ]);
  });
});
