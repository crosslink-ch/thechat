import { invoke } from "@tauri-apps/api/core";
import { warn as logWarn, formatError } from "../log";

const MAX_LINES = 2000;
const MAX_BYTES = 50_000; // 50KB

/**
 * Cap tool-call output to MAX_LINES lines / MAX_BYTES bytes so the transcript
 * stays tractable. On overflow, writes the full original content to a file in
 * the app data dir and appends a pointer so the model can re-read the full
 * output on demand (via the `read` tool). Pointer file retention is 7 days.
 */
export async function truncateToolResult(content: string): Promise<string> {
  const lines = content.split("\n");
  if (lines.length <= MAX_LINES && content.length <= MAX_BYTES) {
    return content;
  }

  let result: string;
  let truncatedLines = 0;
  if (lines.length > MAX_LINES) {
    result = lines.slice(0, MAX_LINES).join("\n");
    truncatedLines = lines.length - MAX_LINES;
  } else {
    result = content;
  }

  let byteTruncated = false;
  if (result.length > MAX_BYTES) {
    result = result.slice(0, MAX_BYTES);
    byteTruncated = true;
  }

  let overflowPath: string | null = null;
  try {
    overflowPath = await invoke<string>("fs_truncation_write", { content });
  } catch (e) {
    logWarn(`[truncate] overflow storage failed: ${formatError(e)}`);
  }

  const notes: string[] = [];
  if (truncatedLines > 0) notes.push(`truncated ${truncatedLines} lines`);
  if (byteTruncated) notes.push("output exceeded byte cap");
  if (overflowPath) {
    notes.push(
      `full output saved at ${overflowPath} — read it with the \`read\` tool if you need more`,
    );
  }

  return `${result}\n\n... (${notes.join("; ")})`;
}
