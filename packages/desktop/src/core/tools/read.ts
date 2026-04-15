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

/** Image result marker — detected by the chat loop to send as image_url content. */
export interface ImageReadResult {
  __image: true;
  mimeType: string;
  dataUrl: string;
}

const IMAGE_EXTENSIONS: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

function getImageMimeType(filePath: string): string | null {
  const lower = filePath.toLowerCase();
  for (const [ext, mime] of Object.entries(IMAGE_EXTENSIONS)) {
    if (lower.endsWith(ext)) return mime;
  }
  return null;
}

export const readTool = defineTool({
  name: "read",
  description: `Read the contents of a file. Returns the file content with line numbers in "cat -n" style format.
By default reads up to 2000 lines. Use offset and limit for large files.
Lines longer than 2000 characters are truncated.
This tool can also read image files (PNG, JPEG, GIF, WebP) — the image will be displayed visually so you can see its contents. SVG files are read as text (XML markup).
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

    const resolvedPath = await resolvePath(file_path, context?.cwd);

    const mimeType = getImageMimeType(resolvedPath);
    if (mimeType) {
      const base64 = await invoke<string>("load_image_base64", {
        filePath: resolvedPath,
      });
      return {
        __image: true,
        mimeType,
        dataUrl: `data:${mimeType};base64,${base64}`,
      } as ImageReadResult;
    }

    const result = await invoke<ReadFileResult>("fs_read_file", {
      filePath: resolvedPath,
      offset: offset ?? undefined,
      limit: limit ?? undefined,
      lineNumbers: true,
    });

    return result;
  },
});
