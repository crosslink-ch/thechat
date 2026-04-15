import { describe, it, expect, vi, beforeEach } from "vitest";
import { runChatLoop } from "./loop";
import type { StreamEvent, ToolDefinition } from "./types";

// Mock streamCompletion
vi.mock("./openrouter", () => ({
  streamCompletion: vi.fn(),
}));
vi.mock("./codex", () => ({
  streamCodexCompletion: vi.fn(),
}));

import { streamCompletion } from "./openrouter";
import { streamCodexCompletion } from "./codex";
const mockStreamCompletion = vi.mocked(streamCompletion);
const mockStreamCodexCompletion = vi.mocked(streamCodexCompletion);

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
      stopReason: "stop",
    });

    const events: StreamEvent[] = [];
    await runChatLoop({
      apiKey: "key",
      model: "model",
      messages: [{ role: "user", content: "hi" }],
      onEvents: (batch) => events.push(...batch),
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
      stopReason: "tool_calls",
    });

    // Second call: returns text (no tool calls)
    mockStreamCompletion.mockResolvedValueOnce({
      text: "The weather in Paris is sunny and 20°C",
      reasoning: "",
      toolCalls: [],
      usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
      stopReason: "stop",
    });

    const events: StreamEvent[] = [];
    await runChatLoop({
      apiKey: "key",
      model: "model",
      messages: [{ role: "user", content: "weather in Paris?" }],
      tools: [mockTool],
      onEvents: (batch) => events.push(...batch),
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
      stopReason: "tool_calls",
    });

    // Second call: model responds after seeing the error
    mockStreamCompletion.mockResolvedValueOnce({
      text: "Sorry, the tool failed",
      reasoning: "",
      toolCalls: [],
      stopReason: "stop",
    });

    const events: StreamEvent[] = [];
    await runChatLoop({
      apiKey: "key",
      model: "model",
      messages: [{ role: "user", content: "do something" }],
      tools: [failingTool],
      onEvents: (batch) => events.push(...batch),
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
        stopReason: "tool_calls",
      };
    });

    const events: StreamEvent[] = [];
    await runChatLoop({
      apiKey: "key",
      model: "model",
      messages: [{ role: "user", content: "loop" }],
      tools: [infiniteTool],
      maxToolRoundtrips: 3,
      onEvents: (batch) => events.push(...batch),
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
      onEvents: (batch) => events.push(...batch),
    });

    expect(mockStreamCompletion).not.toHaveBeenCalled();
    expect(events).toHaveLength(0);
  });

  it("handles unknown tool name", async () => {
    mockStreamCompletion.mockResolvedValueOnce({
      text: "",
      reasoning: "",
      toolCalls: [{ id: "call_1", name: "nonexistent_tool", args: {} }],
      stopReason: "tool_calls",
    });

    mockStreamCompletion.mockResolvedValueOnce({
      text: "I don't know that tool",
      reasoning: "",
      toolCalls: [],
      stopReason: "stop",
    });

    const events: StreamEvent[] = [];
    await runChatLoop({
      apiKey: "key",
      model: "model",
      messages: [{ role: "user", content: "use unknown tool" }],
      tools: [],
      onEvents: (batch) => events.push(...batch),
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

  it("reuses one codex turn id across tool roundtrips", async () => {
    const mockTool: ToolDefinition = {
      name: "get_weather",
      description: "Get weather",
      parameters: { type: "object", properties: {} },
      execute: vi.fn().mockResolvedValue({ temp: 20 }),
    };

    mockStreamCodexCompletion.mockResolvedValueOnce({
      text: "",
      reasoning: "",
      toolCalls: [{ id: "call_1", name: "get_weather", args: { city: "Paris" } }],
      stopReason: "tool_calls",
    });
    mockStreamCodexCompletion.mockResolvedValueOnce({
      text: "Sunny",
      reasoning: "",
      toolCalls: [],
      stopReason: "stop",
    });

    await runChatLoop({
      apiKey: "",
      model: "gpt-5.4",
      provider: "codex",
      codexAuth: { accessToken: "token", accountId: "acct_123" },
      convId: "conv_123",
      messages: [{ role: "user", content: "weather?" }],
      tools: [mockTool],
      onEvents: () => {},
    });

    expect(mockStreamCodexCompletion).toHaveBeenCalledTimes(2);
    const firstTurnId = mockStreamCodexCompletion.mock.calls[0][0].turnId;
    const secondTurnId = mockStreamCodexCompletion.mock.calls[1][0].turnId;
    expect(firstTurnId).toMatch(/^turn_/);
    expect(firstTurnId).toBe(secondTurnId);
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
      stopReason: "tool_calls",
    });

    mockStreamCompletion.mockResolvedValueOnce({
      text: "Done",
      reasoning: "",
      toolCalls: [],
      stopReason: "stop",
    });

    const events: StreamEvent[] = [];
    await runChatLoop({
      apiKey: "key",
      model: "model",
      messages: [{ role: "user", content: "do something slow" }],
      tools: [asyncTool],
      onEvents: (batch) => events.push(...batch),
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
      stopReason: "tool_calls",
    });

    mockStreamCompletion.mockResolvedValueOnce({
      text: "Permission was denied",
      reasoning: "",
      toolCalls: [],
      stopReason: "stop",
    });

    const events: StreamEvent[] = [];
    await runChatLoop({
      apiKey: "key",
      model: "model",
      messages: [{ role: "user", content: "run guarded" }],
      tools: [deniedTool],
      onEvents: (batch) => events.push(...batch),
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
        stopReason: "tool_calls",
      });
    }

    // Round 4: doom loop detected, text-only call (no tools)
    mockStreamCompletion.mockResolvedValueOnce({
      text: "Here is my best answer based on what I found.",
      reasoning: "",
      toolCalls: [],
      usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
      stopReason: "stop",
    });

    const events: StreamEvent[] = [];
    await runChatLoop({
      apiKey: "key",
      model: "model",
      messages: [{ role: "user", content: "read foo" }],
      tools: [stubbornTool],
      onEvents: (batch) => events.push(...batch),
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
      stopReason: "tool_calls",
    });
    mockStreamCompletion.mockResolvedValueOnce({
      text: "",
      reasoning: "",
      toolCalls: [{ id: "call_2", name: "read_file", args: { path: "/b.txt" } }],
      stopReason: "tool_calls",
    });
    mockStreamCompletion.mockResolvedValueOnce({
      text: "",
      reasoning: "",
      toolCalls: [{ id: "call_3", name: "read_file", args: { path: "/c.txt" } }],
      stopReason: "tool_calls",
    });
    mockStreamCompletion.mockResolvedValueOnce({
      text: "Done reading all files",
      reasoning: "",
      toolCalls: [],
      usage: { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 },
      stopReason: "stop",
    });

    const events: StreamEvent[] = [];
    await runChatLoop({
      apiKey: "key",
      model: "model",
      messages: [{ role: "user", content: "read files" }],
      tools: [readTool],
      onEvents: (batch) => events.push(...batch),
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
      stopReason: "tool_calls",
    });

    // Round 2: model calls the dynamically-loaded tool
    mockStreamCompletion.mockResolvedValueOnce({
      text: "",
      reasoning: "",
      toolCalls: [{ id: "call_2", name: "kubectl__get_pods", args: {} }],
      stopReason: "tool_calls",
    });

    // Round 3: text response
    mockStreamCompletion.mockResolvedValueOnce({
      text: "Here are your pods",
      reasoning: "",
      toolCalls: [],
      usage: { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 },
      stopReason: "stop",
    });

    const events: StreamEvent[] = [];
    await runChatLoop({
      apiKey: "key",
      model: "model",
      messages: [{ role: "user", content: "list pods" }],
      getTools,
      onEvents: (batch) => events.push(...batch),
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

  // -- Queued messages tests --

  it("consumes a queued message when LLM finishes with no tool calls", async () => {
    // Scenario: LLM responds with text, but user has typed a follow-up.
    // The loop should inject the queued message and call the LLM again.
    let getQueuedCallCount = 0;

    // Round 1: LLM gives a text response (no tools)
    mockStreamCompletion.mockResolvedValueOnce({
      text: "Here's my answer.",
      reasoning: "",
      toolCalls: [],
      stopReason: "stop",
    });

    // Round 2: LLM sees the queued user message and responds
    mockStreamCompletion.mockResolvedValueOnce({
      text: "And here's the follow-up answer.",
      reasoning: "",
      toolCalls: [],
      usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
      stopReason: "stop",
    });

    const events: StreamEvent[] = [];
    await runChatLoop({
      apiKey: "key",
      model: "model",
      messages: [{ role: "user", content: "first question" }],
      getQueuedMessages: () => {
        getQueuedCallCount++;
        // On first drain (when loop would finish after round 1), return a queued message
        if (getQueuedCallCount === 1) {
          return [{ id: "qm-1", content: "follow-up question" }];
        }
        return [];
      },
      onEvents: (batch) => events.push(...batch),
    });

    // LLM was called twice — once for original, once after queued message
    expect(mockStreamCompletion).toHaveBeenCalledTimes(2);

    // queued-message-consumed event was emitted
    const consumedEvents = events.filter((e) => e.type === "queued-message-consumed");
    expect(consumedEvents).toHaveLength(1);
    expect(consumedEvents[0]).toEqual({
      type: "queued-message-consumed",
      id: "qm-1",
      content: "follow-up question",
    });

    // The second LLM call should contain the assistant response + queued user message
    const secondCallMessages = mockStreamCompletion.mock.calls[1][0].messages;
    // Should have: system, user("first question"), assistant("Here's my answer."), user("follow-up question")
    const assistantMsg = secondCallMessages.find(
      (m: Record<string, unknown>) => m.role === "assistant" && m.content === "Here's my answer.",
    );
    expect(assistantMsg).toBeDefined();
    const queuedUserMsg = secondCallMessages[secondCallMessages.length - 1];
    expect(queuedUserMsg).toEqual({ role: "user", content: "follow-up question" });

    // Finished successfully
    expect(events.some((e) => e.type === "finish")).toBe(true);
  });

  it("injects queued message after tool results between roundtrips", async () => {
    // Scenario: LLM calls a tool. While the tool runs, user types a message.
    // After tool results are appended, the queued message is injected.
    // The next LLM call sees both the tool result AND the user message.
    const tool: ToolDefinition = {
      name: "search",
      description: "Search",
      parameters: { type: "object", properties: {} },
      execute: vi.fn().mockResolvedValue({ results: ["found it"] }),
    };

    let getQueuedCallCount = 0;

    // Round 1: LLM calls the tool
    mockStreamCompletion.mockResolvedValueOnce({
      text: "Let me search for that.",
      reasoning: "",
      toolCalls: [{ id: "call_1", name: "search", args: { query: "test" } }],
      stopReason: "tool_calls",
    });

    // Round 2: LLM sees tool result + queued message, responds with text
    mockStreamCompletion.mockResolvedValueOnce({
      text: "Found the results, and addressing your follow-up.",
      reasoning: "",
      toolCalls: [],
      usage: { prompt_tokens: 30, completion_tokens: 15, total_tokens: 45 },
      stopReason: "stop",
    });

    const events: StreamEvent[] = [];
    await runChatLoop({
      apiKey: "key",
      model: "model",
      messages: [{ role: "user", content: "find something" }],
      tools: [tool],
      getQueuedMessages: () => {
        getQueuedCallCount++;
        // First drain happens after tool results. Return a queued message.
        if (getQueuedCallCount === 1) {
          return [{ id: "qm-1", content: "also check this" }];
        }
        return [];
      },
      onEvents: (batch) => events.push(...batch),
    });

    expect(mockStreamCompletion).toHaveBeenCalledTimes(2);

    // The consumed event was emitted
    const consumed = events.filter((e) => e.type === "queued-message-consumed");
    expect(consumed).toHaveLength(1);
    expect(consumed[0]).toMatchObject({ id: "qm-1", content: "also check this" });

    // The second LLM call should have: system, user, assistant+tool_calls, tool result, queued user msg
    const secondCallMessages = mockStreamCompletion.mock.calls[1][0].messages as Array<Record<string, unknown>>;
    const toolResultMsg = secondCallMessages.find((m) => m.role === "tool");
    expect(toolResultMsg).toBeDefined();
    // The queued user message should come after the tool result
    const toolResultIdx = secondCallMessages.indexOf(toolResultMsg!);
    const queuedMsg = secondCallMessages[toolResultIdx + 1];
    expect(queuedMsg).toEqual({ role: "user", content: "also check this" });

    expect(events.some((e) => e.type === "finish")).toBe(true);
  });

  it("drains multiple queued messages at once", async () => {
    // User types two messages while LLM is working. Both are consumed together.
    mockStreamCompletion.mockResolvedValueOnce({
      text: "First response.",
      reasoning: "",
      toolCalls: [],
      stopReason: "stop",
    });

    mockStreamCompletion.mockResolvedValueOnce({
      text: "Addressing both questions.",
      reasoning: "",
      toolCalls: [],
      usage: { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 },
      stopReason: "stop",
    });

    let drained = false;
    const events: StreamEvent[] = [];
    await runChatLoop({
      apiKey: "key",
      model: "model",
      messages: [{ role: "user", content: "initial" }],
      getQueuedMessages: () => {
        if (!drained) {
          drained = true;
          return [
            { id: "qm-1", content: "question two" },
            { id: "qm-2", content: "question three" },
          ];
        }
        return [];
      },
      onEvents: (batch) => events.push(...batch),
    });

    // Both queued messages consumed
    const consumed = events.filter((e) => e.type === "queued-message-consumed");
    expect(consumed).toHaveLength(2);
    expect(consumed[0]).toMatchObject({ id: "qm-1", content: "question two" });
    expect(consumed[1]).toMatchObject({ id: "qm-2", content: "question three" });

    // Second call messages should contain both user messages after assistant
    const secondCallMessages = mockStreamCompletion.mock.calls[1][0].messages as Array<Record<string, unknown>>;
    const userMessages = secondCallMessages.filter((m) => m.role === "user");
    expect(userMessages).toContainEqual({ role: "user", content: "question two" });
    expect(userMessages).toContainEqual({ role: "user", content: "question three" });
    // Order matters: question two before question three
    const idxTwo = secondCallMessages.findIndex(
      (m) => m.role === "user" && m.content === "question two",
    );
    const idxThree = secondCallMessages.findIndex(
      (m) => m.role === "user" && m.content === "question three",
    );
    expect(idxTwo).toBeLessThan(idxThree);
  });

  it("finishes normally when getQueuedMessages always returns empty", async () => {
    mockStreamCompletion.mockResolvedValueOnce({
      text: "done",
      reasoning: "",
      toolCalls: [],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      stopReason: "stop",
    });

    const events: StreamEvent[] = [];
    const getQueuedMessages = vi.fn().mockReturnValue([]);
    await runChatLoop({
      apiKey: "key",
      model: "model",
      messages: [{ role: "user", content: "hi" }],
      getQueuedMessages,
      onEvents: (batch) => events.push(...batch),
    });

    expect(mockStreamCompletion).toHaveBeenCalledTimes(1);
    expect(events.some((e) => e.type === "finish")).toBe(true);
    // No consumed events
    expect(events.filter((e) => e.type === "queued-message-consumed")).toHaveLength(0);
    // getQueuedMessages was still called (at the finish check)
    expect(getQueuedMessages).toHaveBeenCalled();
  });

  it("handles queued messages at both injection points in a multi-round conversation", async () => {
    // Complex scenario: tool call roundtrip with queue + text-only finish with queue
    // Round 1: tool call
    // After tool results: user queued "msg-A"
    // Round 2: text-only, but user queued "msg-B" → continue
    // Round 3: text-only, no queue → finish
    const tool: ToolDefinition = {
      name: "lookup",
      description: "Look up data",
      parameters: { type: "object", properties: {} },
      execute: vi.fn().mockResolvedValue("data-result"),
    };

    let drainCount = 0;

    // Round 1: tool call
    mockStreamCompletion.mockResolvedValueOnce({
      text: "",
      reasoning: "",
      toolCalls: [{ id: "call_1", name: "lookup", args: { key: "x" } }],
      stopReason: "tool_calls",
    });

    // Round 2: text-only (but queue will have msg-B)
    mockStreamCompletion.mockResolvedValueOnce({
      text: "Here's the lookup result and msg-A response.",
      reasoning: "",
      toolCalls: [],
      stopReason: "stop",
    });

    // Round 3: text-only, queue empty → finish
    mockStreamCompletion.mockResolvedValueOnce({
      text: "Final answer.",
      reasoning: "",
      toolCalls: [],
      usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
      stopReason: "stop",
    });

    const events: StreamEvent[] = [];
    await runChatLoop({
      apiKey: "key",
      model: "model",
      messages: [{ role: "user", content: "start" }],
      tools: [tool],
      getQueuedMessages: () => {
        drainCount++;
        if (drainCount === 1) return [{ id: "qm-A", content: "msg-A" }]; // after tool results
        if (drainCount === 2) return [{ id: "qm-B", content: "msg-B" }]; // at text-only finish check
        return [];
      },
      onEvents: (batch) => events.push(...batch),
    });

    expect(mockStreamCompletion).toHaveBeenCalledTimes(3);

    const consumed = events.filter((e) => e.type === "queued-message-consumed");
    expect(consumed).toHaveLength(2);
    expect(consumed[0]).toMatchObject({ id: "qm-A", content: "msg-A" });
    expect(consumed[1]).toMatchObject({ id: "qm-B", content: "msg-B" });

    // Round 2 messages should include msg-A after tool result
    const round2Messages = mockStreamCompletion.mock.calls[1][0].messages as Array<Record<string, unknown>>;
    const msgA = round2Messages.find(
      (m) => m.role === "user" && m.content === "msg-A",
    );
    expect(msgA).toBeDefined();

    // Round 3 messages should include assistant text + msg-B
    const round3Messages = mockStreamCompletion.mock.calls[2][0].messages as Array<Record<string, unknown>>;
    const assistantText = round3Messages.find(
      (m) => m.role === "assistant" && m.content === "Here's the lookup result and msg-A response.",
    );
    expect(assistantText).toBeDefined();
    const msgB = round3Messages.find(
      (m) => m.role === "user" && m.content === "msg-B",
    );
    expect(msgB).toBeDefined();

    expect(events.some((e) => e.type === "finish")).toBe(true);
  });

  it("preserves assistant text in workingMessages when queue continues the loop", async () => {
    // When the LLM responds with text and no tool calls, and a queued message
    // continues the loop, the assistant text must be preserved so the LLM
    // sees its own previous response.
    mockStreamCompletion.mockResolvedValueOnce({
      text: "I think the answer is 42.",
      reasoning: "",
      toolCalls: [],
      stopReason: "stop",
    });

    mockStreamCompletion.mockResolvedValueOnce({
      text: "Yes, I'm sure about 42.",
      reasoning: "",
      toolCalls: [],
      usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
      stopReason: "stop",
    });

    let drained = false;
    const events: StreamEvent[] = [];
    await runChatLoop({
      apiKey: "key",
      model: "model",
      messages: [{ role: "user", content: "what's the answer?" }],
      getQueuedMessages: () => {
        if (!drained) {
          drained = true;
          return [{ id: "qm-1", content: "are you sure?" }];
        }
        return [];
      },
      onEvents: (batch) => events.push(...batch),
    });

    // Verify the second call has the assistant's previous response
    const secondCallMessages = mockStreamCompletion.mock.calls[1][0].messages as Array<Record<string, unknown>>;

    // Find the assistant message — should be present and before the queued user message
    const assistantIdx = secondCallMessages.findIndex(
      (m) => m.role === "assistant" && m.content === "I think the answer is 42.",
    );
    const userIdx = secondCallMessages.findIndex(
      (m) => m.role === "user" && m.content === "are you sure?",
    );
    expect(assistantIdx).toBeGreaterThan(-1);
    expect(userIdx).toBeGreaterThan(assistantIdx);
  });

  it("does not preserve empty assistant text when queue continues", async () => {
    // Edge case: LLM returns empty text with no tool calls (unusual but possible)
    mockStreamCompletion.mockResolvedValueOnce({
      text: "",
      reasoning: "",
      toolCalls: [],
      stopReason: "stop",
    });

    mockStreamCompletion.mockResolvedValueOnce({
      text: "OK here you go.",
      reasoning: "",
      toolCalls: [],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      stopReason: "stop",
    });

    let drained = false;
    await runChatLoop({
      apiKey: "key",
      model: "model",
      messages: [{ role: "user", content: "hi" }],
      getQueuedMessages: () => {
        if (!drained) {
          drained = true;
          return [{ id: "qm-1", content: "hello?" }];
        }
        return [];
      },
      onEvents: () => {},
    });

    // Second call should NOT have an empty assistant message
    const secondCallMessages = mockStreamCompletion.mock.calls[1][0].messages as Array<Record<string, unknown>>;
    const emptyAssistant = secondCallMessages.find(
      (m) => m.role === "assistant" && m.content === "",
    );
    expect(emptyAssistant).toBeUndefined();
  });

  it("queued messages do not interfere with doom loop detection", async () => {
    // Doom loop detection tracks tool calls, not queued messages.
    // A queued message injected between rounds shouldn't reset the doom counter.
    const stubbornTool: ToolDefinition = {
      name: "read_file",
      description: "Read a file",
      parameters: { type: "object", properties: {} },
      execute: vi.fn().mockResolvedValue("contents"),
    };

    let drainCount = 0;

    // 3 rounds of identical tool calls (triggers doom loop on round 4)
    for (let i = 0; i < 3; i++) {
      mockStreamCompletion.mockResolvedValueOnce({
        text: "",
        reasoning: "",
        toolCalls: [{ id: `call_${i}`, name: "read_file", args: { path: "/same.txt" } }],
        stopReason: "tool_calls",
      });
    }

    // Round 4 (doom loop recovery): text-only call
    mockStreamCompletion.mockResolvedValueOnce({
      text: "I'm stuck.",
      reasoning: "",
      toolCalls: [],
      stopReason: "stop",
    });

    const events: StreamEvent[] = [];
    await runChatLoop({
      apiKey: "key",
      model: "model",
      messages: [{ role: "user", content: "read file" }],
      tools: [stubbornTool],
      getQueuedMessages: () => {
        drainCount++;
        // Inject a queued message after the first tool round
        if (drainCount === 1) {
          return [{ id: "qm-1", content: "try harder" }];
        }
        return [];
      },
      onEvents: (batch) => events.push(...batch),
    });

    // Doom loop was still detected despite the queued message
    const doomError = events.find(
      (e) => e.type === "error" && e.error.includes("Doom loop"),
    );
    expect(doomError).toBeDefined();
    // The queued message was still consumed before doom detection
    const consumed = events.filter((e) => e.type === "queued-message-consumed");
    expect(consumed).toHaveLength(1);
  });

  it("respects maxToolRoundtrips even with queued messages extending the loop", async () => {
    // Queued messages can extend the loop beyond what the user originally sent,
    // but maxToolRoundtrips should still cap total iterations.
    let round = 0;
    mockStreamCompletion.mockImplementation(async () => {
      round++;
      if (round <= 3) {
        return {
          text: `Response ${round}`,
          reasoning: "",
          toolCalls: [{ id: `call_${round}`, name: "tool", args: { n: round } }],
          stopReason: "tool_calls",
        };
      }
      return {
        text: "Final",
        reasoning: "",
        toolCalls: [],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        stopReason: "stop",
      };
    });

    const tool: ToolDefinition = {
      name: "tool",
      description: "A tool",
      parameters: { type: "object", properties: {} },
      execute: vi.fn().mockResolvedValue("ok"),
    };

    const events: StreamEvent[] = [];
    await runChatLoop({
      apiKey: "key",
      model: "model",
      messages: [{ role: "user", content: "go" }],
      tools: [tool],
      maxToolRoundtrips: 2,
      // Keep feeding queued messages — should not bypass maxToolRoundtrips
      getQueuedMessages: () => [{ id: `qm-${round}`, content: `extra ${round}` }],
      onEvents: (batch) => events.push(...batch),
    });

    // Should hit max roundtrips error regardless of queued messages
    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent).toBeDefined();
    if (errorEvent && errorEvent.type === "error") {
      expect(errorEvent.error).toContain("maximum tool roundtrips");
    }
  });

  it("handles streamCompletion error", async () => {
    mockStreamCompletion.mockRejectedValueOnce(new Error("API failed"));

    const events: StreamEvent[] = [];
    await runChatLoop({
      apiKey: "key",
      model: "model",
      messages: [{ role: "user", content: "hi" }],
      onEvents: (batch) => events.push(...batch),
    });

    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent).toBeDefined();
    if (errorEvent && errorEvent.type === "error") {
      expect(errorEvent.error).toContain("API failed");
    }
  });

  it("returns error results for truncated tool calls and lets the model recover", async () => {
    const batchTool: ToolDefinition = {
      name: "batch",
      description: "Batch tool",
      parameters: { type: "object", properties: {} },
      execute: vi.fn(),
    };

    // First call: truncated response with incomplete tool call
    mockStreamCompletion.mockResolvedValueOnce({
      text: "",
      reasoning: "",
      toolCalls: [{ id: "call_1", name: "batch", args: {} }],
      stopReason: "length",
    });

    // Second call: model recovers after seeing the error
    mockStreamCompletion.mockResolvedValueOnce({
      text: "Let me try a simpler approach.",
      reasoning: "",
      toolCalls: [],
      usage: { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 },
      stopReason: "stop",
    });

    const events: StreamEvent[] = [];
    await runChatLoop({
      apiKey: "key",
      model: "model",
      messages: [{ role: "user", content: "do many things" }],
      tools: [batchTool],
      onEvents: (batch) => events.push(...batch),
    });

    // Tool should NOT have been executed
    expect(batchTool.execute).not.toHaveBeenCalled();

    // Error tool result should be emitted back
    const toolResults = events.filter((e) => e.type === "tool-result");
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]).toMatchObject({
      type: "tool-result",
      toolCallId: "call_1",
      isError: true,
    });
    if (toolResults[0].type === "tool-result") {
      expect(toolResults[0].result).toHaveProperty("error");
    }

    // Model got a second turn to recover
    expect(mockStreamCompletion).toHaveBeenCalledTimes(2);

    // The second call should contain the tool error in messages
    const secondCallMessages = mockStreamCompletion.mock.calls[1][0].messages as Array<Record<string, unknown>>;
    const toolMsg = secondCallMessages.find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    expect(JSON.parse(toolMsg!.content as string).error).toContain("truncated");

    // Should finish successfully
    expect(events.some((e) => e.type === "finish")).toBe(true);
  });

  it("sends image tool results as image_url content parts", async () => {
    const readTool: ToolDefinition = {
      name: "read",
      description: "Read a file",
      parameters: { type: "object", properties: {} },
      execute: vi.fn().mockResolvedValue({
        __image: true,
        mimeType: "image/png",
        dataUrl: "data:image/png;base64,iVBORw0KGgo=",
      }),
    };

    // First call: model asks to read an image
    mockStreamCompletion.mockResolvedValueOnce({
      text: "",
      reasoning: "",
      toolCalls: [{ id: "call_img", name: "read", args: { file_path: "/tmp/screenshot.png" } }],
      stopReason: "tool_calls",
    });

    // Second call: model responds after seeing the image
    mockStreamCompletion.mockResolvedValueOnce({
      text: "I can see the screenshot.",
      reasoning: "",
      toolCalls: [],
      usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 },
      stopReason: "stop",
    });

    const events: StreamEvent[] = [];
    await runChatLoop({
      apiKey: "key",
      model: "model",
      messages: [{ role: "user", content: "look at this image" }],
      tools: [readTool],
      onEvents: (batch) => events.push(...batch),
    });

    // The second API call should have an image_url content array in the tool message
    const secondCallMessages = mockStreamCompletion.mock.calls[1][0].messages as Array<Record<string, unknown>>;
    const toolMsg = secondCallMessages.find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    expect(toolMsg!.tool_call_id).toBe("call_img");
    expect(toolMsg!.content).toEqual([
      { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } },
    ]);
  });

  describe("UI block validation retry", () => {
    it("retries silently when a ```tsx ui``` block fails to compile", async () => {
      mockStreamCompletion.mockResolvedValueOnce({
        text: "Here you go:\n```tsx ui\nfunction Component() { return <div>\n```\n",
        reasoning: "",
        toolCalls: [],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        stopReason: "stop",
      });
      mockStreamCompletion.mockResolvedValueOnce({
        text: "Here you go:\n```tsx ui\nfunction Component() { return <div>ok</div>; }\n```\n",
        reasoning: "",
        toolCalls: [],
        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
        stopReason: "stop",
      });

      const events: StreamEvent[] = [];
      await runChatLoop({
        apiKey: "key",
        model: "model",
        messages: [{ role: "user", content: "show me a div" }],
        onEvents: (batch) => events.push(...batch),
      });

      expect(mockStreamCompletion).toHaveBeenCalledTimes(2);

      const retryEvent = events.find((e) => e.type === "ui-retry");
      expect(retryEvent).toBeDefined();
      if (retryEvent?.type === "ui-retry") {
        expect(retryEvent.attempt).toBe(1);
        expect(retryEvent.errors.length).toBeGreaterThan(0);
      }

      // Second call should include the broken assistant message and synthetic feedback
      const secondCallMessages = mockStreamCompletion.mock.calls[1][0].messages as Array<Record<string, unknown>>;
      expect(secondCallMessages.some((m) => m.role === "assistant" && typeof m.content === "string" && (m.content as string).includes("<div>"))).toBe(true);
      const feedbackUserMsg = secondCallMessages.filter((m) => m.role === "user").pop();
      expect(feedbackUserMsg).toBeDefined();
      expect(feedbackUserMsg!.content).toContain("failed to render");

      // Finish event should fire only after the successful retry
      const finishEvent = events.find((e) => e.type === "finish");
      expect(finishEvent).toBeDefined();

      // The retry fired before the finish
      const retryIdx = events.findIndex((e) => e.type === "ui-retry");
      const finishIdx = events.findIndex((e) => e.type === "finish");
      expect(retryIdx).toBeLessThan(finishIdx);
    });

    it("gives up after MAX_UI_RETRIES and emits finish with the last attempt", async () => {
      const brokenResponse = {
        text: "Try:\n```tsx ui\nfunction Component() { throw new Error('boom'); }\n```\n",
        reasoning: "",
        toolCalls: [],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        stopReason: "stop" as const,
      };
      mockStreamCompletion.mockResolvedValue(brokenResponse);

      const events: StreamEvent[] = [];
      await runChatLoop({
        apiKey: "key",
        model: "model",
        messages: [{ role: "user", content: "component please" }],
        onEvents: (batch) => events.push(...batch),
      });

      // initial attempt + 2 retries = 3 total calls
      expect(mockStreamCompletion).toHaveBeenCalledTimes(3);
      const retries = events.filter((e) => e.type === "ui-retry");
      expect(retries).toHaveLength(2);

      // Finish event still fires so the user sees the last (broken) attempt with its error box
      expect(events.some((e) => e.type === "finish")).toBe(true);
    });

    it("does not retry when the response has no ui blocks", async () => {
      mockStreamCompletion.mockResolvedValueOnce({
        text: "Just plain text answer.",
        reasoning: "",
        toolCalls: [],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
        stopReason: "stop",
      });

      const events: StreamEvent[] = [];
      await runChatLoop({
        apiKey: "key",
        model: "model",
        messages: [{ role: "user", content: "hi" }],
        onEvents: (batch) => events.push(...batch),
      });

      expect(mockStreamCompletion).toHaveBeenCalledTimes(1);
      expect(events.some((e) => e.type === "ui-retry")).toBe(false);
      expect(events.some((e) => e.type === "finish")).toBe(true);
    });
  });
});
