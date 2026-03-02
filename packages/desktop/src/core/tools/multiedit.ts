import { invoke } from "@tauri-apps/api/core";
import { requestPermission } from "../permission";
import type { ToolExecutionContext } from "../types";
import { resolvePath } from "./resolve-path";
import { defineTool } from "./define";

interface EditFileResult {
  success: boolean;
  replacements: number;
}

interface EditOperation {
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

export const multiEditTool = defineTool({
  name: "multiedit",
  description: `Apply multiple edits to a single file in sequence. Each edit is an exact string replacement.
Permission is requested once for all edits. Edits are applied in order.
If any edit fails, subsequent edits are skipped and the error is reported.
Use this when you need to make several changes to the same file.`,
  parameters: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "Path to the file to edit. Can be relative to the project directory or absolute.",
      },
      edits: {
        type: "array",
        items: {
          type: "object",
          properties: {
            old_string: { type: "string", description: "The exact string to find" },
            new_string: { type: "string", description: "The replacement string" },
            replace_all: { type: "boolean", description: "Replace all occurrences" },
          },
          required: ["old_string", "new_string"],
        },
        description: "Array of edit operations to apply in sequence",
      },
    },
    required: ["file_path", "edits"],
  },
  execute: async (args, context?: ToolExecutionContext) => {
    const { file_path, edits } = args as {
      file_path: string;
      edits: EditOperation[];
    };

    const resolvedPath = await resolvePath(file_path, context?.cwd);

    await requestPermission({
      command: `multiedit ${resolvedPath}`,
      description: `Apply ${edits.length} edits to ${resolvedPath}`,
      convId: context?.convId,
    });

    const results: Array<{ index: number; success: boolean; error?: string }> = [];

    for (let i = 0; i < edits.length; i++) {
      const edit = edits[i];
      try {
        await invoke<EditFileResult>("fs_edit_file", {
          filePath: resolvedPath,
          oldString: edit.old_string,
          newString: edit.new_string,
          replaceAll: edit.replace_all ?? undefined,
        });
        results.push({ index: i, success: true });
      } catch (e) {
        results.push({ index: i, success: false, error: String(e) });
        break; // Stop on first failure
      }
    }

    const successful = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;

    return {
      total: edits.length,
      applied: successful,
      failed,
      results,
    };
  },
});
