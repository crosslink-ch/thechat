import { invoke } from "@tauri-apps/api/core";
import { requestPermission } from "../permission";
import { defineTool } from "./define";

interface EditFileResult {
  success: boolean;
  replacements: number;
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
        description: "Absolute path to the file to edit",
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
  execute: async (args) => {
    const { file_path, old_string, new_string, replace_all } = args as {
      file_path: string;
      old_string: string;
      new_string: string;
      replace_all?: boolean;
    };

    await requestPermission({
      command: `edit ${file_path}`,
      description: `Edit file: replace string in ${file_path}`,
    });

    const result = await invoke<EditFileResult>("fs_edit_file", {
      filePath: file_path,
      oldString: old_string,
      newString: new_string,
      replaceAll: replace_all ?? undefined,
    });

    return result;
  },
});
