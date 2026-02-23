/**
 * Resolve a file path against a working directory.
 * Returns the path unchanged if it's already absolute, starts with ~, or no cwd is set.
 */
export function resolvePath(filePath: string, cwd?: string): string {
  if (!cwd || filePath.startsWith("/") || filePath.startsWith("~")) return filePath;
  return cwd.endsWith("/") ? cwd + filePath : cwd + "/" + filePath;
}
