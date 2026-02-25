import { describe, it, expect, vi, beforeEach } from "vitest";
import { batchTool, setBatchToolRegistry } from "./batch";
import { requestPermission, usePermissionStore } from "../permission";
import { usePermissionModeStore } from "../../stores/permission-mode";
import type { ToolDefinition } from "../types";

beforeEach(() => {
  vi.clearAllMocks();
  usePermissionStore.setState({ pending: {} });
  usePermissionModeStore.setState({ mode: "request" });
});

const CONV_ID = "test-conv";

type BatchResult = {
  total: number;
  successful: number;
  failed: number;
  results: Array<{ index: number; tool: string; success: boolean; result?: unknown; error?: string }>;
};

/** A tool whose execute calls requestPermission, like real tools (shell, write, edit) do. */
function makePermissionTool(name: string): ToolDefinition {
  return {
    name,
    description: `Tool ${name}`,
    parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] },
    execute: async (args, context) => {
      await requestPermission({
        command: `${name} ${(args as { cmd: string }).cmd}`,
        description: `Run ${name}`,
        convId: context?.convId,
      });
      return { ok: true, tool: name };
    },
  };
}

function getQueue(convId = CONV_ID) {
  return usePermissionStore.getState().pending[convId] ?? [];
}

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

describe("batch + permissions", () => {
  it("completes when a single tool's permission is denied", async () => {
    const tool = makePermissionTool("shell");
    setBatchToolRegistry([tool]);

    const batchPromise = batchTool.execute(
      { tool_calls: [{ tool: "shell", args: { cmd: "rm -rf /" } }] },
      { convId: CONV_ID },
    ) as Promise<BatchResult>;

    // Permission request should appear in the queue
    await vi.waitFor(() => expect(getQueue()).toHaveLength(1));
    expect(getQueue()[0].command).toBe("shell rm -rf /");

    // Deny it
    getQueue()[0].reject("User denied permission");

    const result = await batchPromise;
    expect(result.total).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.successful).toBe(0);
    expect(result.results[0].success).toBe(false);
    expect(result.results[0].error).toContain("User denied permission");

    // Queue should be empty
    expect(getQueue()).toHaveLength(0);
  });

  it("completes when a single tool's permission is allowed", async () => {
    const tool = makePermissionTool("shell");
    setBatchToolRegistry([tool]);

    const batchPromise = batchTool.execute(
      { tool_calls: [{ tool: "shell", args: { cmd: "ls" } }] },
      { convId: CONV_ID },
    ) as Promise<BatchResult>;

    await vi.waitFor(() => expect(getQueue()).toHaveLength(1));
    getQueue()[0].resolve();

    const result = await batchPromise;
    expect(result.total).toBe(1);
    expect(result.successful).toBe(1);
    expect(result.results[0].result).toEqual({ ok: true, tool: "shell" });
  });

  it("queues permissions from multiple parallel tools and processes them one by one", async () => {
    const shellTool = makePermissionTool("shell");
    const writeTool = makePermissionTool("write");
    const editTool = makePermissionTool("edit");
    setBatchToolRegistry([shellTool, writeTool, editTool]);

    const batchPromise = batchTool.execute(
      {
        tool_calls: [
          { tool: "shell", args: { cmd: "git status" } },
          { tool: "write", args: { cmd: "foo.txt" } },
          { tool: "edit", args: { cmd: "bar.txt" } },
        ],
      },
      { convId: CONV_ID },
    ) as Promise<BatchResult>;

    // All three tools run in parallel; all request permission concurrently
    await vi.waitFor(() => expect(getQueue()).toHaveLength(3));

    // The UI would show the first one — resolve it
    expect(getQueue()[0].command).toBe("shell git status");
    getQueue()[0].resolve();

    // After resolving the first, 2 remain
    await vi.waitFor(() => expect(getQueue()).toHaveLength(2));
    expect(getQueue()[0].command).toBe("write foo.txt");
    getQueue()[0].resolve();

    // One left
    await vi.waitFor(() => expect(getQueue()).toHaveLength(1));
    expect(getQueue()[0].command).toBe("edit bar.txt");
    getQueue()[0].resolve();

    const result = await batchPromise;
    expect(result.total).toBe(3);
    expect(result.successful).toBe(3);
    expect(result.failed).toBe(0);
  });

  it("handles a mix of allowed and denied permissions across parallel tools", async () => {
    const shellTool = makePermissionTool("shell");
    const writeTool = makePermissionTool("write");
    setBatchToolRegistry([shellTool, writeTool]);

    const batchPromise = batchTool.execute(
      {
        tool_calls: [
          { tool: "shell", args: { cmd: "dangerous" } },
          { tool: "write", args: { cmd: "safe.txt" } },
        ],
      },
      { convId: CONV_ID },
    ) as Promise<BatchResult>;

    await vi.waitFor(() => expect(getQueue()).toHaveLength(2));

    // Deny the first (shell), allow the second (write)
    getQueue()[0].reject("Not allowed");
    await vi.waitFor(() => expect(getQueue()).toHaveLength(1));
    getQueue()[0].resolve();

    const result = await batchPromise;
    expect(result.total).toBe(2);
    expect(result.successful).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.results[0].success).toBe(false);
    expect(result.results[0].error).toContain("Not allowed");
    expect(result.results[1].success).toBe(true);
  });

  it("surfaces user feedback at top level when permission is denied with feedback", async () => {
    const shellTool = makePermissionTool("shell");
    setBatchToolRegistry([shellTool]);

    const batchPromise = batchTool.execute(
      { tool_calls: [{ tool: "shell", args: { cmd: "rm -rf /" } }] },
      { convId: CONV_ID },
    ) as Promise<BatchResult>;

    await vi.waitFor(() => expect(getQueue()).toHaveLength(1));
    getQueue()[0].reject("User denied permission. User feedback: use git clean instead");

    const result = await batchPromise;
    expect(result.failed).toBe(1);

    // Feedback should be in the individual result error
    expect(result.results[0].error).toContain("use git clean instead");

    // Feedback should ALSO be surfaced at the top level so the model sees it clearly
    expect(result).toHaveProperty("user_feedback");
    const feedback = (result as any).user_feedback as string[];
    expect(feedback).toHaveLength(1);
    expect(feedback[0]).toContain("shell");
    expect(feedback[0]).toContain("use git clean instead");
  });

  it("surfaces feedback from multiple denied tools at top level", async () => {
    const shellTool = makePermissionTool("shell");
    const writeTool = makePermissionTool("write");
    setBatchToolRegistry([shellTool, writeTool]);

    const batchPromise = batchTool.execute(
      {
        tool_calls: [
          { tool: "shell", args: { cmd: "dangerous" } },
          { tool: "write", args: { cmd: "secret.txt" } },
        ],
      },
      { convId: CONV_ID },
    ) as Promise<BatchResult>;

    await vi.waitFor(() => expect(getQueue()).toHaveLength(2));

    getQueue()[0].reject("User denied permission. User feedback: don't run dangerous commands");
    await vi.waitFor(() => expect(getQueue()).toHaveLength(1));
    getQueue()[0].reject("User denied permission. User feedback: don't write to that file");

    const result = await batchPromise;
    expect(result.failed).toBe(2);

    const feedback = (result as any).user_feedback as string[];
    expect(feedback).toHaveLength(2);
    expect(feedback[0]).toContain("don't run dangerous commands");
    expect(feedback[1]).toContain("don't write to that file");
  });

  it("does not include user_feedback field when denied without feedback", async () => {
    const shellTool = makePermissionTool("shell");
    setBatchToolRegistry([shellTool]);

    const batchPromise = batchTool.execute(
      { tool_calls: [{ tool: "shell", args: { cmd: "ls" } }] },
      { convId: CONV_ID },
    ) as Promise<BatchResult>;

    await vi.waitFor(() => expect(getQueue()).toHaveLength(1));
    getQueue()[0].reject("User denied permission");

    const result = await batchPromise;
    expect(result.failed).toBe(1);
    expect(result.results[0].error).toContain("User denied permission");
    // No user_feedback field when there's no actual feedback text
    expect(result).not.toHaveProperty("user_feedback");
  });

  it("mixes permission-requiring tools with non-permission tools", async () => {
    const shellTool = makePermissionTool("shell");
    const readTool: ToolDefinition = {
      name: "read",
      description: "Read (no permission needed)",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      execute: vi.fn().mockResolvedValue({ content: "file contents" }),
    };
    setBatchToolRegistry([shellTool, readTool]);

    const batchPromise = batchTool.execute(
      {
        tool_calls: [
          { tool: "read", args: { path: "foo.txt" } },
          { tool: "shell", args: { cmd: "echo hi" } },
          { tool: "read", args: { path: "bar.txt" } },
        ],
      },
      { convId: CONV_ID },
    ) as Promise<BatchResult>;

    // Only the shell tool needs permission; the reads complete immediately
    await vi.waitFor(() => expect(getQueue()).toHaveLength(1));
    expect(getQueue()[0].command).toBe("shell echo hi");
    getQueue()[0].resolve();

    const result = await batchPromise;
    expect(result.total).toBe(3);
    expect(result.successful).toBe(3);
    expect(result.failed).toBe(0);
  });
});
