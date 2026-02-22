import { invoke } from "@tauri-apps/api/core";
import { requestPermission } from "../permission";
import type { ToolExecutionContext } from "../types";
import { defineTool } from "./define";

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

IMPORTANT: Prefer using specialized tools over shell commands:
- Use "read" instead of cat/head/tail
- Use "write" instead of echo/cat with redirects
- Use "edit" instead of sed/awk
- Use "glob" instead of find/ls for finding files
- Use "grep" instead of grep/rg for searching file contents
- Use "list" instead of ls/tree for directory listings

Use shell for: git commands, running scripts, installing packages, build commands, and system tasks that don't have a dedicated tool.

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
      workdir: {
        type: "string",
        description: "Working directory for the command. Defaults to the project root.",
      },
    },
    required: ["command", "description"],
  },
  execute: async (args, context?: ToolExecutionContext) => {
    const { command, description, timeout, workdir } = args as {
      command: string;
      description: string;
      timeout?: number;
      workdir?: string;
    };

    await requestPermission({ command, description });

    const processId = crypto.randomUUID();

    // If the chat loop is aborted, kill the running process
    const abortHandler = () => {
      invoke("kill_shell_process", { processId }).catch(() => {});
    };
    context?.signal?.addEventListener("abort", abortHandler, { once: true });

    try {
      const result = await invoke<ShellResult>("execute_shell_command", {
        command,
        timeout: timeout ?? undefined,
        workdir: workdir ?? undefined,
        processId,
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
    } finally {
      context?.signal?.removeEventListener("abort", abortHandler);
    }
  },
});
