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

    expect(mockTool.execute).toHaveBeenCalledWith({ city: "Paris" }, { signal: undefined });
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
    let callCount = 0;

    const infiniteTool: ToolDefinition = {
      name: "infinite_tool",
      description: "Never stops",
      parameters: { type: "object", properties: {} },
      execute: vi.fn().mockResolvedValue("again"),
    };

    // Each call returns a tool call with different args (to avoid doom loop)
    mockStreamCompletion.mockImplementation(async () => {
      callCount++;
      return {
        text: "",
        reasoning: "",
        toolCalls: [{ id: `call_${callCount}`, name: "infinite_tool", args: { attempt: callCount } }],
      };
    });

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

  it("waits for async tool that resolves after a delay", async () => {
    const asyncTool: ToolDefinition = {
      name: "slow_tool",
      description: "A tool that takes time",
      parameters: { type: "object", properties: {} },
      execute: vi.fn().mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve({ done: true }), 50)),
      ),
    };

    mockStreamCompletion.mockResolvedValueOnce({
      text: "",
      reasoning: "",
      toolCalls: [{ id: "call_1", name: "slow_tool", args: {} }],
    });

    mockStreamCompletion.mockResolvedValueOnce({
      text: "Done",
      reasoning: "",
      toolCalls: [],
    });

    const events: StreamEvent[] = [];
    await runChatLoop({
      apiKey: "key",
      model: "model",
      messages: [{ role: "user", content: "do something slow" }],
      tools: [asyncTool],
      onEvent: (e) => events.push(e),
    });

    expect(asyncTool.execute).toHaveBeenCalled();
    const toolResult = events.find((e) => e.type === "tool-result");
    expect(toolResult).toMatchObject({
      type: "tool-result",
      isError: false,
    });
    if (toolResult && toolResult.type === "tool-result") {
      expect(toolResult.result).toEqual({ done: true });
    }
  });

  it("handles async tool rejection (permission denied) as error result", async () => {
    const deniedTool: ToolDefinition = {
      name: "guarded_tool",
      description: "A tool that requires permission",
      parameters: { type: "object", properties: {} },
      execute: vi.fn().mockRejectedValue(new Error("User denied permission")),
    };

    mockStreamCompletion.mockResolvedValueOnce({
      text: "",
      reasoning: "",
      toolCalls: [{ id: "call_1", name: "guarded_tool", args: {} }],
    });

    mockStreamCompletion.mockResolvedValueOnce({
      text: "Permission was denied",
      reasoning: "",
      toolCalls: [],
    });

    const events: StreamEvent[] = [];
    await runChatLoop({
      apiKey: "key",
      model: "model",
      messages: [{ role: "user", content: "run guarded" }],
      tools: [deniedTool],
      onEvent: (e) => events.push(e),
    });

    const toolResult = events.find((e) => e.type === "tool-result");
    expect(toolResult).toMatchObject({
      type: "tool-result",
      toolCallId: "call_1",
      isError: true,
    });

    // The error message should be passed back to the LLM
    const secondCallMessages = mockStreamCompletion.mock.calls[1][0].messages;
    const toolMsg = secondCallMessages.find(
      (m: Record<string, unknown>) => m.role === "tool",
    );
    expect(toolMsg).toBeDefined();
    const parsed = JSON.parse(toolMsg!.content as string);
    expect(parsed.error).toContain("User denied permission");
  });

  it("detects doom loop and forces text-only response", async () => {
    const stubbornTool: ToolDefinition = {
      name: "read_file",
      description: "Read a file",
      parameters: { type: "object", properties: {} },
      execute: vi.fn().mockResolvedValue("file contents"),
    };

    // Rounds 1-3: model keeps calling the same tool with same args
    for (let i = 0; i < 3; i++) {
      mockStreamCompletion.mockResolvedValueOnce({
        text: "",
        reasoning: "",
        toolCalls: [{ id: `call_${i}`, name: "read_file", args: { path: "/foo.txt" } }],
      });
    }

    // Round 4: doom loop detected, text-only call (no tools)
    mockStreamCompletion.mockResolvedValueOnce({
      text: "Here is my best answer based on what I found.",
      reasoning: "",
      toolCalls: [],
      usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
    });

    const events: StreamEvent[] = [];
    await runChatLoop({
      apiKey: "key",
      model: "model",
      messages: [{ role: "user", content: "read foo" }],
      tools: [stubbornTool],
      onEvent: (e) => events.push(e),
    });

    // Tool was executed 3 times before doom loop was detected
    expect(stubbornTool.execute).toHaveBeenCalledTimes(3);

    // Doom loop error event was emitted
    const doomError = events.find(
      (e) => e.type === "error" && e.error.includes("Doom loop"),
    );
    expect(doomError).toBeDefined();

    // Final text-only call was made (4th streamCompletion call, without tools)
    expect(mockStreamCompletion).toHaveBeenCalledTimes(4);
    const lastCall = mockStreamCompletion.mock.calls[3][0];
    expect(lastCall.tools).toBeUndefined();

    // Finished successfully
    expect(events.some((e) => e.type === "finish")).toBe(true);
  });

  it("does not trigger doom loop for same tool with different args", async () => {
    const readTool: ToolDefinition = {
      name: "read_file",
      description: "Read a file",
      parameters: { type: "object", properties: {} },
      execute: vi.fn().mockResolvedValue("contents"),
    };

    // 3 calls to same tool but with different args each time
    mockStreamCompletion.mockResolvedValueOnce({
      text: "",
      reasoning: "",
      toolCalls: [{ id: "call_1", name: "read_file", args: { path: "/a.txt" } }],
    });
    mockStreamCompletion.mockResolvedValueOnce({
      text: "",
      reasoning: "",
      toolCalls: [{ id: "call_2", name: "read_file", args: { path: "/b.txt" } }],
    });
    mockStreamCompletion.mockResolvedValueOnce({
      text: "",
      reasoning: "",
      toolCalls: [{ id: "call_3", name: "read_file", args: { path: "/c.txt" } }],
    });
    mockStreamCompletion.mockResolvedValueOnce({
      text: "Done reading all files",
      reasoning: "",
      toolCalls: [],
      usage: { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 },
    });

    const events: StreamEvent[] = [];
    await runChatLoop({
      apiKey: "key",
      model: "model",
      messages: [{ role: "user", content: "read files" }],
      tools: [readTool],
      onEvent: (e) => events.push(e),
    });

    // No doom loop error
    const doomError = events.find(
      (e) => e.type === "error" && e.error.includes("Doom loop"),
    );
    expect(doomError).toBeUndefined();

    // Normal finish
    expect(events.some((e) => e.type === "finish")).toBe(true);
    expect(readTool.execute).toHaveBeenCalledTimes(3);
  });

  it("picks up new tools via getTools between iterations", async () => {
    const initialTool: ToolDefinition = {
      name: "skill",
      description: "Load a skill",
      parameters: { type: "object", properties: {} },
      execute: vi.fn().mockResolvedValue({ success: true }),
    };

    const dynamicTool: ToolDefinition = {
      name: "kubectl__get_pods",
      description: "List pods",
      parameters: { type: "object", properties: {} },
      execute: vi.fn().mockResolvedValue({ pods: ["pod-1"] }),
    };

    // getTools returns only initialTool on first call, then both on second
    let callCount = 0;
    const getTools = vi.fn(() => {
      callCount++;
      if (callCount <= 1) return [initialTool];
      return [initialTool, dynamicTool];
    });

    // Round 1: model calls skill tool
    mockStreamCompletion.mockResolvedValueOnce({
      text: "",
      reasoning: "",
      toolCalls: [{ id: "call_1", name: "skill", args: { name: "k8s" } }],
    });

    // Round 2: model calls the dynamically-loaded tool
    mockStreamCompletion.mockResolvedValueOnce({
      text: "",
      reasoning: "",
      toolCalls: [{ id: "call_2", name: "kubectl__get_pods", args: {} }],
    });

    // Round 3: text response
    mockStreamCompletion.mockResolvedValueOnce({
      text: "Here are your pods",
      reasoning: "",
      toolCalls: [],
      usage: { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 },
    });

    const events: StreamEvent[] = [];
    await runChatLoop({
      apiKey: "key",
      model: "model",
      messages: [{ role: "user", content: "list pods" }],
      getTools,
      onEvent: (e) => events.push(e),
    });

    // getTools called at start of each iteration (3 iterations)
    expect(getTools).toHaveBeenCalledTimes(3);

    // Both tools were executed successfully
    expect(initialTool.execute).toHaveBeenCalledWith({ name: "k8s" }, { signal: undefined });
    expect(dynamicTool.execute).toHaveBeenCalledWith({}, { signal: undefined });

    // The dynamic tool result should not be an error
    const dynamicResult = events.find(
      (e) => e.type === "tool-result" && e.toolName === "kubectl__get_pods",
    );
    expect(dynamicResult).toMatchObject({ isError: false });

    // The second streamCompletion call should include both tools
    const secondCallTools = mockStreamCompletion.mock.calls[1][0].tools;
    expect(secondCallTools).toHaveLength(2);
    expect(secondCallTools!.map((t: ToolDefinition) => t.name)).toContain("kubectl__get_pods");
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
