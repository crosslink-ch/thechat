import { invoke } from "@tauri-apps/api/core";
import { requestPermission } from "../permission";
import type { ToolExecutionContext } from "../types";
import { resolvePath } from "./resolve-path";
import { defineTool } from "./define";
import { replace } from "./replace";

interface WriteFileResult {
  success: boolean;
  bytes_written: number;
}

export const editTool = defineTool({
  name: "edit",
  description: `Perform exact string replacement in a file. Finds old_string and replaces it with new_string.
The edit will FAIL if old_string is not found in the file.
The edit will FAIL if old_string appears more than once (unless replace_all is true).
Provide enough surrounding context in old_string to make the match unique.
The user will be asked for permission before editing.
Use this tool instead of sed or awk.`,
  parameters: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "Path to the file to edit. Can be relative to the project directory or absolute.",
      },
      old_string: {
        type: "string",
        description: "The exact string to find and replace. Must match exactly including whitespace.",
      },
      new_string: {
        type: "string",
        description: "The replacement string",
      },
      replace_all: {
        type: "boolean",
        description: "If true, replace all occurrences. Default: false (replace first only, error if multiple found)",
      },
    },
    required: ["file_path", "old_string", "new_string"],
  },
  execute: async (args, context?: ToolExecutionContext) => {
    const { file_path, old_string, new_string, replace_all } = args as {
      file_path: string;
      old_string: string;
      new_string: string;
      replace_all?: boolean;
    };

    const resolvedPath = await resolvePath(file_path, context?.cwd);

    await requestPermission({
      command: `edit ${resolvedPath}`,
      description: `Edit file: replace string in ${resolvedPath}`,
      convId: context?.convId,
    });

    const content = await invoke<string>("fs_read_file_raw", {
      filePath: resolvedPath,
    });

    const newContent = replace(content, old_string, new_string, replace_all);

    await invoke<WriteFileResult>("fs_write_file", {
      filePath: resolvedPath,
      content: newContent,
    });

    return { success: true, replacements: replace_all ? undefined : 1 };
  },
});
