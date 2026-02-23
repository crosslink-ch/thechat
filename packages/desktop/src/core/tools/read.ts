import { invoke } from "@tauri-apps/api/core";
import type { ToolExecutionContext } from "../types";
import { resolvePath } from "./resolve-path";
import { defineTool } from "./define";

interface ReadFileResult {
  content: string;
  total_lines: number;
  lines_read: number;
  truncated: boolean;
}

export const readTool = defineTool({
  name: "read",
  description: `Read the contents of a file. Returns the file content with line numbers in "cat -n" style format.
By default reads up to 2000 lines. Use offset and limit for large files.
Lines longer than 2000 characters are truncated.
Use this tool instead of shell commands like cat, head, or tail.`,
  parameters: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "Path to the file to read. Can be relative to the project directory or absolute.",
      },
      offset: {
        type: "number",
        description: "Line number to start reading from (0-based). Default: 0",
      },
      limit: {
        type: "number",
        description: "Maximum number of lines to read. Default: 2000",
      },
    },
    required: ["file_path"],
  },
  execute: async (args, context?: ToolExecutionContext) => {
    const { file_path, offset, limit } = args as {
      file_path: string;
      offset?: number;
      limit?: number;
    };

    const resolvedPath = resolvePath(file_path, context?.cwd);

    const result = await invoke<ReadFileResult>("fs_read_file", {
      filePath: resolvedPath,
      offset: offset ?? undefined,
      limit: limit ?? undefined,
      lineNumbers: true,
    });

    return result;
  },
});
