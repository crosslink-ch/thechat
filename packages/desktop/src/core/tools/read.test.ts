import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { readTool } from "./read";

const mockInvoke = vi.mocked(invoke);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("readTool", () => {
  it("has correct name", () => {
    expect(readTool.name).toBe("read");
  });

  it("calls fs_read_file with correct params", async () => {
    mockInvoke.mockResolvedValueOnce({
      content: "     1\thello\n",
      total_lines: 1,
      lines_read: 1,
      truncated: false,
    });

    const result = await readTool.execute({ file_path: "/tmp/test.txt" });

    expect(mockInvoke).toHaveBeenCalledWith("fs_read_file", {
      filePath: "/tmp/test.txt",
      offset: undefined,
      limit: undefined,
      lineNumbers: true,
    });
    expect(result).toHaveProperty("content");
  });

  it("passes offset and limit", async () => {
    mockInvoke.mockResolvedValueOnce({
      content: "",
      total_lines: 100,
      lines_read: 10,
      truncated: true,
    });

    await readTool.execute({ file_path: "/tmp/test.txt", offset: 5, limit: 10 });

    expect(mockInvoke).toHaveBeenCalledWith("fs_read_file", {
      filePath: "/tmp/test.txt",
      offset: 5,
      limit: 10,
      lineNumbers: true,
    });
  });

  it("does not require permission (read-only)", async () => {
    mockInvoke.mockResolvedValueOnce({
      content: "data",
      total_lines: 1,
      lines_read: 1,
      truncated: false,
    });

    // Should not throw even without permission handler
    await readTool.execute({ file_path: "/tmp/test.txt" });
    expect(mockInvoke).toHaveBeenCalled();
  });
});
