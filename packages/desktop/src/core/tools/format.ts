import { invoke } from "@tauri-apps/api/core";
import { debug as logDebug, formatError } from "../../log";

/**
 * Attempt to format a file in place after a write/edit. Silent no-op if the
 * formatter isn't installed, the extension isn't recognized, or the formatter
 * fails — a failed format must never mask a successful write.
 */
export async function tryFormat(filePath: string): Promise<void> {
  try {
    const formatted = await invoke<boolean>("fs_format_file", { filePath });
    if (formatted) {
      logDebug(`[format] ${filePath} formatted in place`);
    }
  } catch (e) {
    logDebug(`[format] ${filePath} skipped: ${formatError(e)}`);
  }
}
