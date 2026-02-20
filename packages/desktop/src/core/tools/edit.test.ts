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
    mockInvoke.mockResolvedValueOnce({ success: true, replacements: 1 });

    await editTool.execute({
      file_path: "/tmp/test.txt",
      old_string: "hello",
      new_string: "goodbye",
    });

    expect(mockRequestPermission).toHaveBeenCalledBefore(mockInvoke);
  });

  it("calls fs_edit_file with correct params", async () => {
    mockRequestPermission.mockResolvedValueOnce(undefined);
    mockInvoke.mockResolvedValueOnce({ success: true, replacements: 1 });

    const result = await editTool.execute({
      file_path: "/tmp/test.txt",
      old_string: "hello",
      new_string: "goodbye",
      replace_all: true,
    });

    expect(mockInvoke).toHaveBeenCalledWith("fs_edit_file", {
      filePath: "/tmp/test.txt",
      oldString: "hello",
      newString: "goodbye",
      replaceAll: true,
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
});
