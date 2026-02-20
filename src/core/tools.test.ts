import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("./permission", () => ({
  requestPermission: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { requestPermission } from "./permission";
// Note: tools/shell.ts imports from "../permission" which resolves to "./permission" at this level
import { shellTool, getCurrentTimeTool, defineTool } from "./tools/index";

const mockInvoke = vi.mocked(invoke);
const mockRequestPermission = vi.mocked(requestPermission);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("defineTool", () => {
  it("returns the tool definition unchanged", () => {
    const tool = defineTool({
      name: "test",
      description: "A test tool",
      parameters: { type: "object", properties: {} },
      execute: () => "result",
    });
    expect(tool.name).toBe("test");
  });
});

describe("getCurrentTimeTool", () => {
  it("has correct name and parameters", () => {
    expect(getCurrentTimeTool.name).toBe("get_current_time");
    expect(getCurrentTimeTool.parameters).toHaveProperty("properties.timezone");
  });
});

describe("shellTool", () => {
  it("has correct name and required parameters", () => {
    expect(shellTool.name).toBe("shell");
    expect(shellTool.parameters).toHaveProperty("properties.command");
    expect(shellTool.parameters).toHaveProperty("properties.description");
    expect((shellTool.parameters as { required: string[] }).required).toContain("command");
    expect((shellTool.parameters as { required: string[] }).required).toContain("description");
  });

  it("calls requestPermission then invoke on approval", async () => {
    mockRequestPermission.mockResolvedValueOnce(undefined);
    mockInvoke.mockResolvedValueOnce({
      stdout: "hello\n",
      stderr: "",
      exit_code: 0,
      timed_out: false,
    });

    const result = await shellTool.execute({
      command: "echo hello",
      description: "Print hello",
    });

    expect(mockRequestPermission).toHaveBeenCalledWith({
      command: "echo hello",
      description: "Print hello",
    });
    expect(mockInvoke).toHaveBeenCalledWith("execute_shell_command", {
      command: "echo hello",
      timeout: undefined,
    });
    expect(result).toEqual({
      stdout: "hello\n",
      stderr: "",
      exit_code: 0,
    });
  });

  it("throws when permission is denied without calling invoke", async () => {
    mockRequestPermission.mockRejectedValueOnce(new Error("User denied permission"));

    await expect(
      shellTool.execute({ command: "rm -rf /", description: "Delete everything" }),
    ).rejects.toThrow("User denied permission");

    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("includes timeout error when command times out", async () => {
    mockRequestPermission.mockResolvedValueOnce(undefined);
    mockInvoke.mockResolvedValueOnce({
      stdout: "partial",
      stderr: "",
      exit_code: -1,
      timed_out: true,
    });

    const result = await shellTool.execute({
      command: "sleep 999",
      description: "Sleep forever",
      timeout: 5,
    });

    expect(result).toHaveProperty("error");
    expect((result as Record<string, unknown>).stdout).toBe("partial");
  });

  it("passes custom timeout to invoke", async () => {
    mockRequestPermission.mockResolvedValueOnce(undefined);
    mockInvoke.mockResolvedValueOnce({
      stdout: "",
      stderr: "",
      exit_code: 0,
      timed_out: false,
    });

    await shellTool.execute({
      command: "ls",
      description: "List files",
      timeout: 30,
    });

    expect(mockInvoke).toHaveBeenCalledWith("execute_shell_command", {
      command: "ls",
      timeout: 30,
    });
  });
});
