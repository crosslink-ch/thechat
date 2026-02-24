/**
 * Resolve a file path against a working directory.
 * Returns the path unchanged if it's already absolute, starts with ~, or no cwd is set.
 */
export function resolvePath(filePath: string, cwd?: string): string {
  if (
    !cwd ||
    filePath.startsWith("/") ||
    filePath.startsWith("~") ||
    /^[a-zA-Z]:[/\\]/.test(filePath) ||
    filePath.startsWith("\\\\")
  )
    return filePath;

  // Use the separator from the cwd (backslash on Windows, forward slash on Unix)
  const sep = cwd.includes("\\") ? "\\" : "/";
  return cwd.endsWith(sep) ? cwd + filePath : cwd + sep + filePath;
}
