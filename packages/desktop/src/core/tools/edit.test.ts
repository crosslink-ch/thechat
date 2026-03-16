import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("../permission", () => ({
  requestPermission: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { requestPermission } from "../permission";
import { editTool } from "./edit";

const mockInvoke = vi.mocked(invoke);
const mockRequestPermission = vi.mocked(requestPermission);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("editTool", () => {
  it("has correct name", () => {
    expect(editTool.name).toBe("edit");
  });

  it("requests permission before editing", async () => {
    mockRequestPermission.mockResolvedValueOnce(undefined);
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "fs_read_file_raw") return "hello world";
      if (cmd === "fs_write_file") return { success: true, bytes_written: 13 };
      return undefined;
    });

    await editTool.execute({
      file_path: "/tmp/test.txt",
      old_string: "hello",
      new_string: "goodbye",
    });

    expect(mockRequestPermission).toHaveBeenCalledTimes(1);
    // First invoke should be the read
    expect(mockInvoke).toHaveBeenNthCalledWith(1, "fs_read_file_raw", {
      filePath: "/tmp/test.txt",
    });
  });

  it("reads file, applies replace, and writes back", async () => {
    mockRequestPermission.mockResolvedValueOnce(undefined);
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "fs_read_file_raw") return "hello world";
      if (cmd === "fs_write_file") return { success: true, bytes_written: 13 };
      return undefined;
    });

    const result = await editTool.execute({
      file_path: "/tmp/test.txt",
      old_string: "hello",
      new_string: "goodbye",
    });

    expect(mockInvoke).toHaveBeenCalledWith("fs_write_file", {
      filePath: "/tmp/test.txt",
      content: "goodbye world",
    });
    expect(result).toEqual({ success: true, replacements: 1 });
  });

  it("throws when permission is denied", async () => {
    mockRequestPermission.mockRejectedValueOnce(new Error("User denied"));

    await expect(
      editTool.execute({
        file_path: "/tmp/test.txt",
        old_string: "a",
        new_string: "b",
      }),
    ).rejects.toThrow("User denied");

    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("throws when old_string is not found", async () => {
    mockRequestPermission.mockResolvedValueOnce(undefined);
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "fs_read_file_raw") return "hello world";
      return undefined;
    });

    await expect(
      editTool.execute({
        file_path: "/tmp/test.txt",
        old_string: "nonexistent",
        new_string: "replacement",
      }),
    ).rejects.toThrow("Could not find oldString");
  });
});
