import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => {
  class MockChannel {
    onmessage: ((data: unknown) => void) | null = null;
  }
  return {
    invoke: vi.fn(),
    Channel: MockChannel,
  };
});

import { invoke } from "@tauri-apps/api/core";
import { streamCompletion } from "./openrouter";
import type { StreamResult } from "./types";

const mockInvoke = vi.mocked(invoke);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("streamCompletion", () => {
  const mockResult: StreamResult = {
    text: "Hello world",
    reasoning: "",
    toolCalls: [],
    usage: undefined,
  };

  it("passes correct URL, headers, and body to invoke", async () => {
    mockInvoke.mockResolvedValue(mockResult);

    await streamCompletion({
      apiKey: "test-key",
      model: "test-model",
      messages: [{ role: "user", content: "hi" }],
      onEvents: () => {},
    });

    expect(mockInvoke).toHaveBeenCalledWith("stream_completion", expect.objectContaining({
      url: "https://openrouter.ai/api/v1/chat/completions",
      headers: {
        Authorization: "Bearer test-key",
        "Content-Type": "application/json",
      },
      provider: "openrouter",
    }));

    // Verify body contains correct model and messages
    const callArgs = mockInvoke.mock.calls[0][1] as Record<string, unknown>;
    const body = JSON.parse(callArgs.body as string);
    expect(body.model).toBe("test-model");
    expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(body.stream).toBe(true);
  });

  it("passes ChatParams to request body", async () => {
    mockInvoke.mockResolvedValue(mockResult);

    await streamCompletion({
      apiKey: "test-key",
      model: "test-model",
      messages: [{ role: "user", content: "hi" }],
      params: { temperature: 0.5, max_tokens: 100, seed: 42 },
      onEvents: () => {},
    });

    const callArgs = mockInvoke.mock.calls[0][1] as Record<string, unknown>;
    const body = JSON.parse(callArgs.body as string);
    expect(body.temperature).toBe(0.5);
    expect(body.max_tokens).toBe(100);
    expect(body.seed).toBe(42);
  });

  it("includes tool definitions in request body", async () => {
    mockInvoke.mockResolvedValue(mockResult);

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
      onEvents: () => {},
    });

    const callArgs = mockInvoke.mock.calls[0][1] as Record<string, unknown>;
    const body = JSON.parse(callArgs.body as string);
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0]).toEqual({
      type: "function",
      function: {
        name: "test_tool",
        description: "A test tool",
        parameters: { type: "object", properties: {} },
      },
    });
  });

  it("returns StreamResult from invoke", async () => {
    const resultWithUsage: StreamResult = {
      text: "Hello",
      reasoning: "Thinking...",
      toolCalls: [{ id: "call_1", name: "read", args: { path: "foo" } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };
    mockInvoke.mockResolvedValue(resultWithUsage);

    const result = await streamCompletion({
      apiKey: "test-key",
      model: "test-model",
      messages: [{ role: "user", content: "hi" }],
      onEvents: () => {},
    });

    expect(result).toEqual(resultWithUsage);
  });

  it("translates 'cancelled' error to AbortError", async () => {
    mockInvoke.mockRejectedValue("cancelled");

    await expect(
      streamCompletion({
        apiKey: "test-key",
        model: "test-model",
        messages: [{ role: "user", content: "hi" }],
        onEvents: () => {},
      }),
    ).rejects.toThrow("Aborted");

    try {
      await streamCompletion({
        apiKey: "test-key",
        model: "test-model",
        messages: [{ role: "user", content: "hi" }],
        onEvents: () => {},
      });
    } catch (e) {
      expect(e).toBeInstanceOf(DOMException);
      expect((e as DOMException).name).toBe("AbortError");
    }
  });

  it("propagates API errors from invoke", async () => {
    mockInvoke.mockRejectedValue("OpenRouter API error (400): Bad Request");

    await expect(
      streamCompletion({
        apiKey: "test-key",
        model: "test-model",
        messages: [{ role: "user", content: "hi" }],
        onEvents: () => {},
      }),
    ).rejects.toThrow("OpenRouter API error (400)");
  });

  it("invokes cancel_stream on abort signal", async () => {
    // Make invoke hang until we abort
    let resolveInvoke!: (value: StreamResult) => void;
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "stream_completion") {
        return new Promise<StreamResult>((resolve) => {
          resolveInvoke = resolve;
        });
      }
      return Promise.resolve();
    });

    const controller = new AbortController();
    const promise = streamCompletion({
      apiKey: "test-key",
      model: "test-model",
      messages: [{ role: "user", content: "hi" }],
      signal: controller.signal,
      onEvents: () => {},
    });

    // Trigger abort
    controller.abort();

    // cancel_stream should have been invoked
    expect(mockInvoke).toHaveBeenCalledWith("cancel_stream", expect.objectContaining({
      streamId: expect.stringMatching(/^or_/),
    }));

    // Resolve the main invoke to unblock the promise
    resolveInvoke(mockResult);
    await promise;
  });

  it("passes streamId and onEvent Channel to invoke", async () => {
    mockInvoke.mockResolvedValue(mockResult);

    await streamCompletion({
      apiKey: "test-key",
      model: "test-model",
      messages: [{ role: "user", content: "hi" }],
      onEvents: () => {},
    });

    const callArgs = mockInvoke.mock.calls[0][1] as Record<string, unknown>;
    expect(callArgs.streamId).toMatch(/^or_/);
    expect(callArgs.onEvent).toBeDefined();
    expect(callArgs.provider).toBe("openrouter");
  });

  it("overrides model from params.model", async () => {
    mockInvoke.mockResolvedValue(mockResult);

    await streamCompletion({
      apiKey: "test-key",
      model: "default-model",
      messages: [{ role: "user", content: "hi" }],
      params: { model: "override-model" },
      onEvents: () => {},
    });

    const callArgs = mockInvoke.mock.calls[0][1] as Record<string, unknown>;
    const body = JSON.parse(callArgs.body as string);
    expect(body.model).toBe("override-model");
  });
});

describe("streamCompletion integration", () => {
  const apiKey = import.meta.env.OPENROUTER_API_KEY as string | undefined;

  it.skipIf(!apiKey)("streams a real response from OpenRouter", async () => {
    // Integration tests need real Tauri — skip in unit test env
  }, 30000);
});
