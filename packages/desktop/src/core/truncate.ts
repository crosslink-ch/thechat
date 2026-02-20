const MAX_LINES = 2000;
const MAX_BYTES = 50_000; // 50KB

export function truncateToolResult(content: string): string {
  const lines = content.split("\n");

  if (lines.length <= MAX_LINES && content.length <= MAX_BYTES) {
    return content;
  }

  // Truncate by lines first
  let result: string;
  if (lines.length > MAX_LINES) {
    result = lines.slice(0, MAX_LINES).join("\n");
    result += `\n\n... (truncated ${lines.length - MAX_LINES} lines)`;
  } else {
    result = content;
  }

  // Then truncate by bytes
  if (result.length > MAX_BYTES) {
    result = result.slice(0, MAX_BYTES);
    result += "\n\n... (truncated, output too large)";
  }

  return result;
}
