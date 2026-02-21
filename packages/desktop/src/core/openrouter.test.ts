import { describe, it, expect, vi, beforeEach } from "vitest";
import { streamCompletion } from "./openrouter";
import type { StreamEvent } from "./types";

// Helper to create a ReadableStream from SSE chunks
function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(encoder.encode(chunks[index]));
        index++;
      } else {
        controller.close();
      }
    },
  });
}

function mockFetch(chunks: string[], status = 200) {
  return Object.assign(
    vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      text: async () => "error body",
      body: sseStream(chunks),
    }),
    { preconnect: vi.fn() }
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("streamCompletion", () => {
  it("parses text-only streaming", async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
      "data: [DONE]\n\n",
    ];

    const events: StreamEvent[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(chunks);

    try {
      const result = await streamCompletion({
        apiKey: "test-key",
        model: "test-model",
        messages: [{ role: "user", content: "hi" }],
        onEvent: (e) => events.push(e),
      });

      expect(result.text).toBe("Hello world");
      expect(result.reasoning).toBe("");
      expect(result.toolCalls).toHaveLength(0);

      const textDeltas = events.filter((e) => e.type === "text-delta");
      expect(textDeltas).toHaveLength(2);
      expect(textDeltas[0]).toEqual({ type: "text-delta", text: "Hello" });
      expect(textDeltas[1]).toEqual({ type: "text-delta", text: " world" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("parses reasoning streaming", async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"reasoning":"Think"}}]}\n\n',
      'data: {"choices":[{"delta":{"reasoning":"ing..."}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"Answer"}}]}\n\n',
      "data: [DONE]\n\n",
    ];

    const events: StreamEvent[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(chunks);

    try {
      const result = await streamCompletion({
        apiKey: "test-key",
        model: "test-model",
        messages: [{ role: "user", content: "hi" }],
        onEvent: (e) => events.push(e),
      });

      expect(result.reasoning).toBe("Thinking...");
      expect(result.text).toBe("Answer");

      const reasoningDeltas = events.filter((e) => e.type === "reasoning-delta");
      expect(reasoningDeltas).toHaveLength(2);
      expect(reasoningDeltas[0]).toEqual({ type: "reasoning-delta", text: "Think" });
      expect(reasoningDeltas[1]).toEqual({ type: "reasoning-delta", text: "ing..." });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("parses reasoning_details streaming", async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"reasoning_details":[{"type":"thinking","thinking":"Deep thought"}]}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"Done"}}]}\n\n',
      "data: [DONE]\n\n",
    ];

    const events: StreamEvent[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(chunks);

    try {
      const result = await streamCompletion({
        apiKey: "test-key",
        model: "test-model",
        messages: [{ role: "user", content: "hi" }],
        onEvent: (e) => events.push(e),
      });

      expect(result.reasoning).toBe("Deep thought");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("parses tool call streaming", async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"get_weather","arguments":""}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"city\\""}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":": \\"Paris\\"}"}}]}}]}\n\n',
      "data: [DONE]\n\n",
    ];

    const events: StreamEvent[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(chunks);

    try {
      const result = await streamCompletion({
        apiKey: "test-key",
        model: "test-model",
        messages: [{ role: "user", content: "weather?" }],
        onEvent: (e) => events.push(e),
      });

      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0]).toEqual({
        id: "call_1",
        name: "get_weather",
        args: { city: "Paris" },
      });

      expect(events.find((e) => e.type === "tool-call-start")).toEqual({
        type: "tool-call-start",
        toolCallId: "call_1",
        toolName: "get_weather",
      });
      expect(events.find((e) => e.type === "tool-call-complete")).toEqual({
        type: "tool-call-complete",
        toolCallId: "call_1",
        toolName: "get_weather",
        args: { city: "Paris" },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("parses multiple tool calls in one response", async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"tool_a","arguments":"{}"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"call_2","function":{"name":"tool_b","arguments":"{}"}}]}}]}\n\n',
      "data: [DONE]\n\n",
    ];

    const events: StreamEvent[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(chunks);

    try {
      const result = await streamCompletion({
        apiKey: "test-key",
        model: "test-model",
        messages: [{ role: "user", content: "do things" }],
        onEvent: (e) => events.push(e),
      });

      expect(result.toolCalls).toHaveLength(2);
      expect(result.toolCalls[0].name).toBe("tool_a");
      expect(result.toolCalls[1].name).toBe("tool_b");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("throws on non-200 response", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch([], 400);

    try {
      await expect(
        streamCompletion({
          apiKey: "test-key",
          model: "test-model",
          messages: [{ role: "user", content: "hi" }],
          onEvent: () => {},
        }),
      ).rejects.toThrow("OpenRouter API error (400)");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("parses usage from final chunk", async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
      'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n',
      "data: [DONE]\n\n",
    ];

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(chunks);

    try {
      const result = await streamCompletion({
        apiKey: "test-key",
        model: "test-model",
        messages: [{ role: "user", content: "hi" }],
        onEvent: () => {},
      });

      expect(result.usage).toEqual({
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("handles partial SSE lines across chunks", async () => {
    // Split an SSE line across two chunks
    const chunks = [
      'data: {"choices":[{"delta":{"conten',
      't":"Hello"}}]}\n\ndata: [DONE]\n\n',
    ];

    const events: StreamEvent[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(chunks);

    try {
      const result = await streamCompletion({
        apiKey: "test-key",
        model: "test-model",
        messages: [{ role: "user", content: "hi" }],
        onEvent: (e) => events.push(e),
      });

      expect(result.text).toBe("Hello");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("passes ChatParams to request body", async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
      "data: [DONE]\n\n",
    ];

    const originalFetch = globalThis.fetch;
    const fetchMock = mockFetch(chunks);
    globalThis.fetch = fetchMock;

    try {
      await streamCompletion({
        apiKey: "test-key",
        model: "test-model",
        messages: [{ role: "user", content: "hi" }],
        params: { temperature: 0.5, max_tokens: 100, seed: 42 },
        onEvent: () => {},
      });

      const callBody = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(callBody.temperature).toBe(0.5);
      expect(callBody.max_tokens).toBe(100);
      expect(callBody.seed).toBe(42);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("includes tool definitions in request body", async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
      "data: [DONE]\n\n",
    ];

    const originalFetch = globalThis.fetch;
    const fetchMock = mockFetch(chunks);
    globalThis.fetch = fetchMock;

    try {
      await streamCompletion({
        apiKey: "test-key",
        model: "test-model",
        messages: [{ role: "user", content: "hi" }],
        tools: [
          {
            name: "test_tool",
            description: "A test tool",
            parameters: { type: "object", properties: {} },
            execute: async () => "result",
          },
        ],
        onEvent: () => {},
      });

      const callBody = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(callBody.tools).toHaveLength(1);
      expect(callBody.tools[0]).toEqual({
        type: "function",
        function: {
          name: "test_tool",
          description: "A test tool",
          parameters: { type: "object", properties: {} },
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("streamCompletion integration", () => {
  const apiKey = import.meta.env.OPENROUTER_API_KEY as string | undefined;

  it.skipIf(!apiKey)("streams a real response from OpenRouter", async () => {
    const events: StreamEvent[] = [];
    const result = await streamCompletion({
      apiKey: apiKey!,
      model: "openai/gpt-4.1-nano",
      messages: [{ role: "user", content: "Say hi in one word" }],
      params: { temperature: 0, max_tokens: 10 },
      onEvent: (e) => events.push(e),
    });

    expect(result.text.length).toBeGreaterThan(0);
    expect(events.some((e) => e.type === "text-delta")).toBe(true);
  }, 30000);
});
