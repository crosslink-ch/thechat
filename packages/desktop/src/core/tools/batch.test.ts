import { describe, it, expect, vi, beforeEach } from "vitest";
import { batchTool, setBatchToolRegistry } from "./batch";
import type { ToolDefinition } from "../types";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("batchTool", () => {
  it("has correct name", () => {
    expect(batchTool.name).toBe("batch");
  });

  it("executes multiple tools in parallel", async () => {
    const toolA: ToolDefinition = {
      name: "tool_a",
      description: "Tool A",
      parameters: { type: "object", properties: {} },
      execute: vi.fn().mockResolvedValue({ data: "a" }),
    };
    const toolB: ToolDefinition = {
      name: "tool_b",
      description: "Tool B",
      parameters: { type: "object", properties: {} },
      execute: vi.fn().mockResolvedValue({ data: "b" }),
    };

    setBatchToolRegistry([toolA, toolB]);

    const result = (await batchTool.execute({
      tool_calls: [
        { tool: "tool_a", args: {} },
        { tool: "tool_b", args: {} },
      ],
    })) as { total: number; successful: number; failed: number; results: unknown[] };

    expect(result.total).toBe(2);
    expect(result.successful).toBe(2);
    expect(result.failed).toBe(0);
    expect(toolA.execute).toHaveBeenCalled();
    expect(toolB.execute).toHaveBeenCalled();
  });

  it("prevents nesting batch calls", async () => {
    setBatchToolRegistry([batchTool]);

    const result = (await batchTool.execute({
      tool_calls: [{ tool: "batch", args: { tool_calls: [] } }],
    })) as { results: Array<{ success: boolean; error: string }> };

    expect(result.results[0].success).toBe(false);
    expect(result.results[0].error).toContain("cannot be used inside batch");
  });

  it("handles unknown tools", async () => {
    setBatchToolRegistry([]);

    const result = (await batchTool.execute({
      tool_calls: [{ tool: "nonexistent", args: {} }],
    })) as { failed: number; results: Array<{ success: boolean; error: string }> };

    expect(result.failed).toBe(1);
    expect(result.results[0].error).toContain("Unknown tool");
  });

  it("handles individual tool errors without stopping others", async () => {
    const goodTool: ToolDefinition = {
      name: "good",
      description: "Works",
      parameters: { type: "object", properties: {} },
      execute: vi.fn().mockResolvedValue("ok"),
    };
    const badTool: ToolDefinition = {
      name: "bad",
      description: "Fails",
      parameters: { type: "object", properties: {} },
      execute: vi.fn().mockRejectedValue(new Error("boom")),
    };

    setBatchToolRegistry([goodTool, badTool]);

    const result = (await batchTool.execute({
      tool_calls: [
        { tool: "bad", args: {} },
        { tool: "good", args: {} },
      ],
    })) as { successful: number; failed: number };

    expect(result.successful).toBe(1);
    expect(result.failed).toBe(1);
  });

  it("rejects unknown fields in args with clear error", async () => {
    const constrained: ToolDefinition = {
      name: "constrained",
      description: "Requires known args only",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
      execute: vi.fn().mockResolvedValue({ ok: true }),
    };

    setBatchToolRegistry([constrained]);

    const result = (await batchTool.execute({
      tool_calls: [{ tool: "constrained", args: { path: ".", extra: true } }],
    })) as { failed: number; results: Array<{ success: boolean; error: string }> };

    expect(result.failed).toBe(1);
    expect(result.results[0].success).toBe(false);
    expect(result.results[0].error).toMatch(/Unknown property 'extra'/);
  });
});
