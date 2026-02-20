import { invoke } from "@tauri-apps/api/core";
import { requestPermission } from "../permission";
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
        description: "Absolute path to the file to write",
      },
      content: {
        type: "string",
        description: "The content to write to the file",
      },
    },
    required: ["file_path", "content"],
  },
  execute: async (args) => {
    const { file_path, content } = args as {
      file_path: string;
      content: string;
    };

    await requestPermission({
      command: `write ${file_path}`,
      description: `Write ${content.length} bytes to ${file_path}`,
    });

    const result = await invoke<WriteFileResult>("fs_write_file", {
      filePath: file_path,
      content,
    });

    return result;
  },
});
