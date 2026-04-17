import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { truncateToolResult } from "./truncate";

const mockInvoke = vi.mocked(invoke);

beforeEach(() => {
  vi.clearAllMocks();
  // Default: overflow-write returns a fake path so the truncate path is exercised
  mockInvoke.mockResolvedValue("/tmp/trunc/tool_000.txt");
});

describe("truncateToolResult", () => {
  it("returns short content unchanged and does not touch disk", async () => {
    const content = "hello world";
    expect(await truncateToolResult(content)).toBe(content);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("truncates content exceeding max lines and writes overflow", async () => {
    const lines = Array.from({ length: 3000 }, (_, i) => `line ${i}`);
    const content = lines.join("\n");
    const result = await truncateToolResult(content);

    expect(result.split("\n").length).toBeLessThan(3000);
    expect(result).toContain("truncated 1000 lines");
    expect(result).toContain("/tmp/trunc/tool_000.txt");
    expect(mockInvoke).toHaveBeenCalledWith("fs_truncation_write", { content });
  });

  it("truncates content exceeding max bytes", async () => {
    const longLine = "x".repeat(60000);
    const result = await truncateToolResult(longLine);

    expect(result.length).toBeLessThan(longLine.length);
    expect(result).toContain("output exceeded byte cap");
  });

  it("preserves content within limits", async () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`);
    const content = lines.join("\n");
    expect(await truncateToolResult(content)).toBe(content);
  });

  it("still truncates even if overflow storage fails", async () => {
    mockInvoke.mockRejectedValueOnce(new Error("disk full"));
    const lines = Array.from({ length: 3000 }, (_, i) => `line ${i}`);
    const result = await truncateToolResult(lines.join("\n"));
    expect(result).toContain("truncated 1000 lines");
    expect(result).not.toContain("full output saved at");
  });
});
