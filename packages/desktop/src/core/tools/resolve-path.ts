import { resolve, isAbsolute } from "@tauri-apps/api/path";

/**
 * Resolve a file path against a working directory using Tauri's
 * cross-platform path handling (delegates to Rust's std::path).
 *
 * Returns the path unchanged if it's already absolute or no cwd is set.
 */
export async function resolvePath(filePath: string, cwd?: string): Promise<string> {
  if (!cwd || await isAbsolute(filePath)) return filePath;
  return resolve(cwd, filePath);
}
