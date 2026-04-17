import { invoke } from "@tauri-apps/api/core";
import type { ToolExecutionContext } from "../types";
import { resolvePath } from "./resolve-path";
import { defineTool } from "./define";

interface ReadFileResult {
  content: string;
  total_lines: number;
  lines_read: number;
  truncated: boolean;
  next_offset?: number;
}

/** Image result marker — detected by the chat loop to send as image_url content. */
export interface ImageReadResult {
  __image: true;
  mimeType: string;
  dataUrl: string;
}

/** PDF result marker — detected by the chat loop to send as a file content part. */
export interface PdfReadResult {
  __pdf: true;
  mimeType: "application/pdf";
  filename: string;
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

function isPdf(filePath: string): boolean {
  return filePath.toLowerCase().endsWith(".pdf");
}

function basename(filePath: string): string {
  const parts = filePath.split(/[\\/]/);
  return parts[parts.length - 1] || filePath;
}

export const readTool = defineTool({
  name: "read",
  description: `Read the contents of a file. Returns file content with line numbers in "cat -n" style.
- By default reads up to 2000 lines or 50KB, whichever comes first. When the output is capped, the result includes a \`next_offset\` you can pass on a follow-up call to keep reading.
- \`offset\` is 1-indexed: offset=1 starts at the first line.
- Lines longer than 2000 characters are truncated.
- Images (PNG, JPEG, GIF, WebP) are returned visually so you can see them. SVGs are read as text (XML).
- PDFs are returned as document attachments so you can read their contents.
- Binary files are rejected with a clear error — use a different tool for them.
- When a path is missing, the error may include "Did you mean: …" suggestions based on nearby filenames.
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
        description: "Line number to start reading from (1-indexed). Default: 1",
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

    if (isPdf(resolvedPath)) {
      const base64 = await invoke<string>("load_image_base64", {
        filePath: resolvedPath,
      });
      return {
        __pdf: true,
        mimeType: "application/pdf",
        filename: basename(resolvedPath),
        dataUrl: `data:application/pdf;base64,${base64}`,
      } as PdfReadResult;
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
