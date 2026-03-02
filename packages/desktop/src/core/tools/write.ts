import { invoke } from "@tauri-apps/api/core";
import { requestPermission } from "../permission";
import type { ToolExecutionContext } from "../types";
import { resolvePath } from "./resolve-path";
import { defineTool } from "./define";

interface WriteFileResult {
  success: boolean;
  bytes_written: number;
}

export const writeTool = defineTool({
  name: "write",
  description: `Write content to a file. Creates the file and any parent directories if they don't exist.
Overwrites existing file content completely.
The user will be asked for permission before writing.
Use this tool instead of shell commands like echo, cat with redirects, or tee.`,
  parameters: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "Path to the file to write. Can be relative to the project directory or absolute.",
      },
      content: {
        type: "string",
        description: "The content to write to the file",
      },
    },
    required: ["file_path", "content"],
  },
  execute: async (args, context?: ToolExecutionContext) => {
    const { file_path, content } = args as {
      file_path: string;
      content: string;
    };

    const resolvedPath = await resolvePath(file_path, context?.cwd);

    await requestPermission({
      command: `write ${resolvedPath}`,
      description: `Write ${content.length} bytes to ${resolvedPath}`,
      convId: context?.convId,
    });

    const result = await invoke<WriteFileResult>("fs_write_file", {
      filePath: resolvedPath,
      content,
    });

    return result;
  },
});
