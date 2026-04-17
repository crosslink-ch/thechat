import { invoke } from "@tauri-apps/api/core";
import { requestPermission } from "../permission";
import type { ToolExecutionContext } from "../types";
import { resolvePath } from "./resolve-path";
import { defineTool } from "./define";
import { replace } from "./replace";
import { tryFormat } from "./format";

interface WriteFileResult {
  success: boolean;
  bytes_written: number;
}

type Op =
  | { kind: "add"; path: string; content: string }
  | { kind: "update"; path: string; hunks: Hunk[] }
  | { kind: "delete"; path: string };

interface Hunk {
  /** Lines in the original file that this hunk replaces (context + removed, in order). */
  oldLines: string[];
  /** Lines that should appear in the file after the hunk is applied. */
  newLines: string[];
}

const BEGIN = "*** Begin Patch";
const END = "*** End Patch";
const ADD = "*** Add File: ";
const UPDATE = "*** Update File: ";
const DELETE = "*** Delete File: ";
const HUNK = "@@";

function stripLinePrefix(line: string, prefix: string): string {
  // The patch format uses "+ " / "- " / "  " but tools often normalize to
  // "+" / "-" / " ". Accept both.
  if (line.startsWith(prefix + " ")) return line.slice(prefix.length + 1);
  if (line.startsWith(prefix)) return line.slice(prefix.length);
  return line;
}

export function parsePatch(patchText: string): Op[] {
  // Normalize line endings so the parser only has to deal with \n
  const raw = patchText.replace(/\r\n/g, "\n");
  const lines = raw.split("\n");

  let i = 0;
  // Optional Begin/End wrapper
  while (i < lines.length && lines[i].trim() === "") i++;
  if (i < lines.length && lines[i].trim() === BEGIN) i++;

  const ops: Op[] = [];

  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === END) break;
    if (line.trim() === "") {
      i++;
      continue;
    }

    if (line.startsWith(ADD)) {
      const path = line.slice(ADD.length).trim();
      i++;
      const content: string[] = [];
      while (i < lines.length && !isSectionHeader(lines[i])) {
        content.push(stripLinePrefix(lines[i], "+"));
        i++;
      }
      ops.push({ kind: "add", path, content: content.join("\n") });
      continue;
    }

    if (line.startsWith(DELETE)) {
      const path = line.slice(DELETE.length).trim();
      i++;
      ops.push({ kind: "delete", path });
      continue;
    }

    if (line.startsWith(UPDATE)) {
      const path = line.slice(UPDATE.length).trim();
      i++;
      const hunks: Hunk[] = [];
      // Each hunk is introduced by a @@ line (body may follow the header on
      // the same line; we accept either form). Lines without a hunk header
      // before them are treated as a single implicit hunk.
      let currentOld: string[] = [];
      let currentNew: string[] = [];
      let inHunk = false;

      const flush = () => {
        if (currentOld.length === 0 && currentNew.length === 0) return;
        hunks.push({ oldLines: currentOld, newLines: currentNew });
        currentOld = [];
        currentNew = [];
      };

      while (i < lines.length && !isSectionHeader(lines[i])) {
        const cur = lines[i];
        if (cur.startsWith(HUNK)) {
          flush();
          inHunk = true;
          i++;
          continue;
        }
        inHunk; // noop; marker used for clarity
        if (cur.startsWith("-")) {
          currentOld.push(stripLinePrefix(cur, "-"));
        } else if (cur.startsWith("+")) {
          currentNew.push(stripLinePrefix(cur, "+"));
        } else {
          // Context line (leading space or plain). Belongs to both old and new.
          const ctx = cur.startsWith(" ") ? cur.slice(1) : cur;
          currentOld.push(ctx);
          currentNew.push(ctx);
        }
        i++;
      }
      flush();

      if (hunks.length === 0) {
        throw new Error(
          `apply_patch: Update File ${path} has no hunks. Provide at least one @@ hunk with context/-/+ lines.`,
        );
      }

      ops.push({ kind: "update", path, hunks });
      continue;
    }

    throw new Error(
      `apply_patch: unexpected line at position ${i + 1}: "${line.slice(0, 80)}"`,
    );
  }

  if (ops.length === 0) {
    throw new Error("apply_patch: patch contained no operations");
  }
  return ops;
}

function isSectionHeader(line: string): boolean {
  return (
    line.startsWith(ADD) ||
    line.startsWith(UPDATE) ||
    line.startsWith(DELETE) ||
    line.trim() === BEGIN ||
    line.trim() === END
  );
}

export const applyPatchTool = defineTool({
  name: "apply_patch",
  description: `Apply a multi-file patch describing Add / Update / Delete operations across one or more files in a single call.
Use this for coordinated multi-file changes (e.g. add a new module plus update three callers).
Format:
  *** Begin Patch
  *** Add File: path/to/new.ts
  +line1
  +line2
  *** Update File: path/to/existing.ts
  @@
   context line
  -old line
  +new line
  *** Delete File: path/to/remove.ts
  *** End Patch

Notes:
- Update hunks use unified-diff-ish syntax: lines prefixed " " (or no prefix) are context, "-" means remove, "+" means add.
- Multiple @@ hunks are allowed per Update File.
- Permission is requested once per affected file before any changes are applied.
- For single-file surgical edits, prefer the \`edit\` or \`multiedit\` tool.`,
  parameters: {
    type: "object",
    properties: {
      patch_text: {
        type: "string",
        description: "Full patch text including the Begin Patch / End Patch markers.",
      },
    },
    required: ["patch_text"],
  },
  execute: async (args, context?: ToolExecutionContext) => {
    const { patch_text } = args as { patch_text: string };
    const ops = parsePatch(patch_text);

    const resolved = await Promise.all(
      ops.map(async (op) => ({ ...op, path: await resolvePath(op.path, context?.cwd) })),
    );

    const summary = resolved
      .map((op) => {
        if (op.kind === "add") return `add ${op.path}`;
        if (op.kind === "delete") return `delete ${op.path}`;
        return `update ${op.path} (${op.hunks.length} hunk${op.hunks.length === 1 ? "" : "s"})`;
      })
      .join("\n  ");

    await requestPermission({
      command: `apply_patch (${resolved.length} file${resolved.length === 1 ? "" : "s"})`,
      description: `Apply patch:\n  ${summary}`,
      convId: context?.convId,
    });

    const results: Array<{
      path: string;
      op: "add" | "update" | "delete";
      success: boolean;
      error?: string;
    }> = [];

    for (const op of resolved) {
      try {
        if (op.kind === "add") {
          await invoke<WriteFileResult>("fs_write_file", {
            filePath: op.path,
            content: op.content,
          });
          await tryFormat(op.path);
          results.push({ path: op.path, op: "add", success: true });
        } else if (op.kind === "delete") {
          await invoke("fs_delete_file", { filePath: op.path });
          results.push({ path: op.path, op: "delete", success: true });
        } else {
          let content = await invoke<string>("fs_read_file_raw", {
            filePath: op.path,
          });
          for (const hunk of op.hunks) {
            const oldStr = hunk.oldLines.join("\n");
            const newStr = hunk.newLines.join("\n");
            if (oldStr === newStr) continue;
            content = replace(content, oldStr, newStr, false);
          }
          await invoke<WriteFileResult>("fs_write_file", {
            filePath: op.path,
            content,
          });
          await tryFormat(op.path);
          results.push({ path: op.path, op: "update", success: true });
        }
      } catch (e) {
        results.push({
          path: op.path,
          op: op.kind,
          success: false,
          error: String(e),
        });
        // Stop on first failure so we don't apply a half-baked patch.
        break;
      }
    }

    const applied = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;
    return {
      total: ops.length,
      applied,
      failed,
      results,
    };
  },
});
