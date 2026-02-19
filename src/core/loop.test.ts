import { describe, it, expect, vi, beforeEach } from "vitest";
import { runChatLoop } from "./loop";
import type { StreamEvent, ToolDefinition } from "./types";

// Mock streamCompletion
vi.mock("./openrouter", () => ({
  streamCompletion: vi.fn(),
}));

import { streamCompletion } from "./openrouter";
const mockStreamCompletion = vi.mocked(streamCompletion);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("runChatLoop", () => {
  it("finishes immediately when no tool calls", async () => {
    mockStreamCompletion.mockResolvedValueOnce({
      text: "hello",
      reasoning: "",
      toolCalls: [],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    });

    const events: StreamEvent[] = [];
    await runChatLoop({
      apiKey: "key",
      model: "model",
      messages: [{ role: "user", content: "hi" }],
      onEvent: (e) => events.push(e),
    });

    expect(mockStreamCompletion).toHaveBeenCalledTimes(1);
    expect(events).toContainEqual({
      type: "finish",
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    });
  });

  it("executes a single tool call roundtrip", async () => {
    const mockTool: ToolDefinition = {
      name: "get_weather",
      description: "Get weather",
      parameters: { type: "object", properties: {} },
      execute: vi.fn().mockResolvedValue({ temp: 20, condition: "sunny" }),
    };

    // First call: returns a tool call
    mockStreamCompletion.mockResolvedValueOnce({
      text: "",
      reasoning: "",
      toolCalls: [{ id: "call_1", name: "get_weather", args: { city: "Paris" } }],
    });

    // Second call: returns text (no tool calls)
    mockStreamCompletion.mockResolvedValueOnce({
      text: "The weather in Paris is sunny and 20°C",
      reasoning: "",
      toolCalls: [],
      usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
    });

    const events: StreamEvent[] = [];
    await runChatLoop({
      apiKey: "key",
      model: "model",
      messages: [{ role: "user", content: "weather in Paris?" }],
      tools: [mockTool],
      onEvent: (e) => events.push(e),
    });

    expect(mockTool.execute).toHaveBeenCalledWith({ city: "Paris" });
    expect(mockStreamCompletion).toHaveBeenCalledTimes(2);

    const toolResult = events.find((e) => e.type === "tool-result");
    expect(toolResult).toEqual({
      type: "tool-result",
      toolCallId: "call_1",
      toolName: "get_weather",
      result: { temp: 20, condition: "sunny" },
      isError: false,
    });

    expect(events.some((e) => e.type === "finish")).toBe(true);
  });

  it("handles tool execution error gracefully", async () => {
    const failingTool: ToolDefinition = {
      name: "broken_tool",
      description: "A tool that fails",
      parameters: { type: "object", properties: {} },
      execute: vi.fn().mockRejectedValue(new Error("Tool exploded")),
    };

    // First call: returns a tool call
    mockStreamCompletion.mockResolvedValueOnce({
      text: "",
      reasoning: "",
      toolCalls: [{ id: "call_1", name: "broken_tool", args: {} }],
    });

    // Second call: model responds after seeing the error
    mockStreamCompletion.mockResolvedValueOnce({
      text: "Sorry, the tool failed",
      reasoning: "",
      toolCalls: [],
    });

    const events: StreamEvent[] = [];
    await runChatLoop({
      apiKey: "key",
      model: "model",
      messages: [{ role: "user", content: "do something" }],
      tools: [failingTool],
      onEvent: (e) => events.push(e),
    });

    const toolResult = events.find((e) => e.type === "tool-result");
    expect(toolResult).toMatchObject({
      type: "tool-result",
      toolCallId: "call_1",
      isError: true,
    });

    // Second call should have the tool error in messages
    const secondCallMessages = mockStreamCompletion.mock.calls[1][0].messages;
    const toolMsg = secondCallMessages.find(
      (m: Record<string, unknown>) => m.role === "tool",
    );
    expect(toolMsg).toBeDefined();
    expect(JSON.parse(toolMsg!.content as string)).toHaveProperty("error");
  });

  it("stops after maxToolRoundtrips", async () => {
    // Always return a tool call
    mockStreamCompletion.mockResolvedValue({
      text: "",
      reasoning: "",
      toolCalls: [{ id: "call_loop", name: "infinite_tool", args: {} }],
    });

    const infiniteTool: ToolDefinition = {
      name: "infinite_tool",
      description: "Never stops",
      parameters: { type: "object", properties: {} },
      execute: vi.fn().mockResolvedValue("again"),
    };

    const events: StreamEvent[] = [];
    await runChatLoop({
      apiKey: "key",
      model: "model",
      messages: [{ role: "user", content: "loop" }],
      tools: [infiniteTool],
      maxToolRoundtrips: 3,
      onEvent: (e) => events.push(e),
    });

    // 3 roundtrips + 1 initial = 4 calls total, then error on exceeding
    expect(mockStreamCompletion).toHaveBeenCalledTimes(4);
    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent).toBeDefined();
    if (errorEvent && errorEvent.type === "error") {
      expect(errorEvent.error).toContain("maximum tool roundtrips");
    }
  });

  it("stops cleanly with aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();

    const events: StreamEvent[] = [];
    await runChatLoop({
      apiKey: "key",
      model: "model",
      messages: [{ role: "user", content: "hi" }],
      signal: controller.signal,
      onEvent: (e) => events.push(e),
    });

    expect(mockStreamCompletion).not.toHaveBeenCalled();
    expect(events).toHaveLength(0);
  });

  it("handles unknown tool name", async () => {
    mockStreamCompletion.mockResolvedValueOnce({
      text: "",
      reasoning: "",
      toolCalls: [{ id: "call_1", name: "nonexistent_tool", args: {} }],
    });

    mockStreamCompletion.mockResolvedValueOnce({
      text: "I don't know that tool",
      reasoning: "",
      toolCalls: [],
    });

    const events: StreamEvent[] = [];
    await runChatLoop({
      apiKey: "key",
      model: "model",
      messages: [{ role: "user", content: "use unknown tool" }],
      tools: [],
      onEvent: (e) => events.push(e),
    });

    const toolResult = events.find((e) => e.type === "tool-result");
    expect(toolResult).toMatchObject({
      type: "tool-result",
      isError: true,
    });
    if (toolResult && toolResult.type === "tool-result") {
      expect(toolResult.result).toHaveProperty("error");
    }
  });

  it("handles streamCompletion error", async () => {
    mockStreamCompletion.mockRejectedValueOnce(new Error("API failed"));

    const events: StreamEvent[] = [];
    await runChatLoop({
      apiKey: "key",
      model: "model",
      messages: [{ role: "user", content: "hi" }],
      onEvent: (e) => events.push(e),
    });

    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent).toBeDefined();
    if (errorEvent && errorEvent.type === "error") {
      expect(errorEvent.error).toContain("API failed");
    }
  });
});
