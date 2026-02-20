import { invoke } from "@tauri-apps/api/core";
import { requestPermission } from "./permission";
import type { ToolDefinition } from "./types";

export function defineTool<TArgs = Record<string, unknown>>(
  tool: ToolDefinition<TArgs>,
): ToolDefinition<TArgs> {
  return tool;
}

export const getCurrentTimeTool = defineTool({
  name: "get_current_time",
  description: "Get the current date and time in ISO 8601 format",
  parameters: {
    type: "object",
    properties: {
      timezone: {
        type: "string",
        description: "IANA timezone name (e.g. 'America/New_York'). Defaults to UTC.",
      },
    },
    required: [],
  },
  execute: (args) => {
    const tz = (args as { timezone?: string }).timezone || "UTC";
    return {
      time: new Date().toLocaleString("en-US", { timeZone: tz }),
      timezone: tz,
      iso: new Date().toISOString(),
    };
  },
});

interface ShellResult {
  stdout: string;
  stderr: string;
  exit_code: number;
  timed_out: boolean;
}

export const shellTool = defineTool({
  name: "shell",
  description: `Execute a shell command on the user's machine. The command runs in the user's login shell.
The user will be asked for permission before the command runs.
Use this for file operations, running scripts, installing packages, git commands, and any system task.
Always provide a short description of what the command does.
Prefer simple, single commands. For multi-step tasks, call the tool multiple times.
The command has a default timeout of 120 seconds.`,
  parameters: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The shell command to execute",
      },
      description: {
        type: "string",
        description: "A short human-readable description of what this command does",
      },
      timeout: {
        type: "number",
        description: "Timeout in seconds (default: 120)",
      },
    },
    required: ["command", "description"],
  },
  execute: async (args) => {
    const { command, description, timeout } = args as {
      command: string;
      description: string;
      timeout?: number;
    };

    await requestPermission({ command, description });

    const result = await invoke<ShellResult>("execute_shell_command", {
      command,
      timeout: timeout ?? undefined,
    });

    if (result.timed_out) {
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exit_code: result.exit_code,
        error: `Command timed out after ${timeout ?? 120} seconds`,
      };
    }

    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exit_code: result.exit_code,
    };
  },
});
