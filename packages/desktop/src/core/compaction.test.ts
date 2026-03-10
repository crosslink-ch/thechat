import { describe, it, expect, vi } from "vitest";
import { isOverflow, pruneToolResults, compactMessages } from "./compaction";
import type { StreamResult, StreamEvent } from "./types";

describe("isOverflow", () => {
  it("returns true when tokens exceed the usable context limit", () => {
    // claude-sonnet-4-6: contextWindow=200K, maxOutput=min(64K,64K)=64K
    // usable = 200K - 64K - 20K(buffer) = 116K
    expect(isOverflow(116_000, "claude-sonnet-4-6")).toBe(true);
    expect(isOverflow(120_000, "claude-sonnet-4-6")).toBe(true);
  });

  it("returns false when tokens are below the limit", () => {
    expect(isOverflow(100_000, "claude-sonnet-4-6")).toBe(false);
    expect(isOverflow(50_000, "claude-sonnet-4-6")).toBe(false);
  });

  it("returns false for unknown models", () => {
    expect(isOverflow(999_999, "unknown-model-xyz")).toBe(false);
  });

  it("accounts for model-specific maxOutputTokens", () => {
    // claude-haiku-4-5: contextWindow=200K, maxOutput=min(64K,64K)=64K, no inputLimit
    // usable = (200K - 64K) - 20K = 116K (same as Sonnet)
    expect(isOverflow(116_000, "claude-haiku-4-5-20251001")).toBe(true);
    expect(isOverflow(100_000, "claude-haiku-4-5-20251001")).toBe(false);
  });

  it("uses inputLimit when available (GPT-5.x Codex models)", () => {
    // gpt-5.3-codex: contextWindow=400K, inputLimit=272K, maxOutput=min(128K,64K)=64K
    // usable = inputLimit - 20K = 252K
    expect(isOverflow(252_000, "gpt-5.3-codex")).toBe(true);
    expect(isOverflow(250_000, "gpt-5.3-codex")).toBe(false);

    // gpt-5.4: contextWindow=1.05M, inputLimit=922K, maxOutput=min(128K,64K)=64K
    // usable = inputLimit - 20K = 902K
    expect(isOverflow(902_000, "gpt-5.4")).toBe(true);
    expect(isOverflow(900_000, "gpt-5.4")).toBe(false);
  });
});

describe("pruneToolResults", () => {
  it("replaces old tool results with placeholder, protecting last 2 user turns", () => {
    const messages: Array<Record<string, unknown>> = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Do stuff" },
      { role: "assistant", content: "", tool_calls: [{ id: "c1" }] },
      { role: "tool", tool_call_id: "c1", content: "A".repeat(500) },
      { role: "user", content: "More stuff" },  // turn boundary 1
      { role: "assistant", content: "", tool_calls: [{ id: "c2" }] },
      { role: "tool", tool_call_id: "c2", content: "B".repeat(500) },
      { role: "user", content: "Even more" },   // turn boundary 2 (protected)
      { role: "assistant", content: "", tool_calls: [{ id: "c3" }] },
      { role: "tool", tool_call_id: "c3", content: "C".repeat(500) },
    ];

    const freed = pruneToolResults(messages);

    // First tool result (before protected zone) should be pruned
    expect(messages[3].content).toBe("[Old tool result content cleared]");
    // Second tool result (at boundary of protection) — protected since it's part of turn 2
    expect(messages[6].content).toBe("B".repeat(500));
    // Third tool result (in protected zone) should NOT be pruned
    expect(messages[9].content).toBe("C".repeat(500));
    expect(freed).toBeGreaterThan(0);
  });

  it("does not prune when all content is in protected turns", () => {
    const messages: Array<Record<string, unknown>> = [
      { role: "system", content: "system" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "", tool_calls: [{ id: "c1" }] },
      { role: "tool", tool_call_id: "c1", content: "X".repeat(500) },
    ];

    const freed = pruneToolResults(messages);
    expect(freed).toBe(0);
    expect(messages[3].content).toBe("X".repeat(500));
  });

  it("skips tool results that are already small", () => {
    const messages: Array<Record<string, unknown>> = [
      { role: "system", content: "system" },
      { role: "user", content: "first" },
      { role: "assistant", content: "", tool_calls: [{ id: "c1" }] },
      { role: "tool", tool_call_id: "c1", content: "tiny" }, // too small to prune
      { role: "user", content: "second" },
      { role: "user", content: "third" },
    ];

    const freed = pruneToolResults(messages);
    expect(freed).toBe(0);
    expect(messages[3].content).toBe("tiny");
  });

  it("does not touch non-tool messages", () => {
    const messages: Array<Record<string, unknown>> = [
      { role: "system", content: "system prompt ".repeat(100) },
      { role: "user", content: "long user message ".repeat(100) },
      { role: "assistant", content: "long assistant message ".repeat(100) },
      { role: "user", content: "turn 1" },
      { role: "user", content: "turn 2" },
    ];

    pruneToolResults(messages);
    expect(messages[0].content).toBe("system prompt ".repeat(100));
    expect(messages[1].content).toBe("long user message ".repeat(100));
    expect(messages[2].content).toBe("long assistant message ".repeat(100));
  });
});

describe("compactMessages", () => {
  it("replaces message history with summary on success", async () => {
    const messages: Array<Record<string, unknown>> = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Build a website" },
      { role: "assistant", content: "Sure, let me start." },
      { role: "user", content: "Add a navbar" },
      { role: "assistant", content: "", tool_calls: [{ id: "c1" }] },
      { role: "tool", tool_call_id: "c1", content: "file written" },
    ];

    const mockProvider = vi.fn().mockResolvedValue({
      text: "## Goal\nBuild a website with a navbar\n\n## Accomplished\nCreated index.html",
      reasoning: "",
      toolCalls: [],
      stopReason: "stop",
    } satisfies StreamResult);

    const events: StreamEvent[] = [];
    const result = await compactMessages(
      messages,
      mockProvider,
      (batch) => events.push(...batch),
    );

    expect(result).toBe(true);
    expect(messages).toHaveLength(4);
    expect(messages[0]).toEqual({ role: "system", content: "You are helpful." });
    expect(messages[1]).toEqual({ role: "user", content: "What did we do so far?" });
    expect((messages[2].content as string)).toContain("Build a website");
    expect(messages[2].role).toBe("assistant");
    expect(messages[3]).toEqual({ role: "user", content: "Continue with the task." });

    // Compaction event emitted
    const compactionEvent = events.find((e) => e.type === "compaction");
    expect(compactionEvent).toBeDefined();
  });

  it("returns false and emits error when provider fails", async () => {
    const messages: Array<Record<string, unknown>> = [
      { role: "system", content: "system" },
      { role: "user", content: "hi" },
    ];
    const mockProvider = vi.fn().mockRejectedValue(new Error("context too large"));

    const events: StreamEvent[] = [];
    const result = await compactMessages(
      messages,
      mockProvider,
      (batch) => events.push(...batch),
    );

    expect(result).toBe(false);
    // Messages should still be there (pruned but not replaced)
    expect(messages.length).toBeGreaterThanOrEqual(2);

    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent).toBeDefined();
  });

  it("returns false when summary is empty", async () => {
    const messages: Array<Record<string, unknown>> = [
      { role: "system", content: "system" },
      { role: "user", content: "hi" },
    ];

    const mockProvider = vi.fn().mockResolvedValue({
      text: "",
      reasoning: "",
      toolCalls: [],
      stopReason: "stop",
    } satisfies StreamResult);

    const result = await compactMessages(messages, mockProvider, () => {});
    expect(result).toBe(false);
  });

  it("re-throws AbortError", async () => {
    const messages: Array<Record<string, unknown>> = [
      { role: "system", content: "system" },
      { role: "user", content: "hi" },
    ];

    const mockProvider = vi.fn().mockRejectedValue(
      new DOMException("Aborted", "AbortError"),
    );

    await expect(
      compactMessages(messages, mockProvider, () => {}),
    ).rejects.toThrow("Aborted");
  });

  it("prunes old tool results before calling provider", async () => {
    const messages: Array<Record<string, unknown>> = [
      { role: "system", content: "system" },
      { role: "user", content: "first" },
      { role: "assistant", content: "", tool_calls: [{ id: "c1" }] },
      { role: "tool", tool_call_id: "c1", content: "X".repeat(1000) },
      { role: "user", content: "second" },
      { role: "user", content: "third" },
      { role: "assistant", content: "response" },
    ];

    const mockProvider = vi.fn().mockResolvedValue({
      text: "Summary here",
      reasoning: "",
      toolCalls: [],
      stopReason: "stop",
    } satisfies StreamResult);

    await compactMessages(messages, mockProvider, () => {});

    // The provider should have been called with pruned messages
    const calledMessages = mockProvider.mock.calls[0][0] as Array<Record<string, unknown>>;
    const toolMsg = calledMessages.find((m) => m.role === "tool");
    expect(toolMsg?.content).toBe("[Old tool result content cleared]");
  });
});
