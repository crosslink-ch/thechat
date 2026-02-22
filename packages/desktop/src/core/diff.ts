export interface DiffLine {
  type: "add" | "remove";
  text: string;
}

/**
 * Compute diff lines from an edit operation.
 * Since edit tools provide exact old/new strings, all old lines are "remove"
 * and all new lines are "add".
 */
export function computeDiffLines(oldStr: string, newStr: string): DiffLine[] {
  const lines: DiffLine[] = [];
  for (const line of oldStr.split("\n")) {
    lines.push({ type: "remove", text: line });
  }
  for (const line of newStr.split("\n")) {
    lines.push({ type: "add", text: line });
  }
  return lines;
}

const MAX_PREVIEW_LINES = 50;

/**
 * Truncate an array of lines, returning the kept lines and how many were omitted.
 */
export function truncateLines<T>(lines: T[], max = MAX_PREVIEW_LINES): { lines: T[]; omitted: number } {
  if (lines.length <= max) return { lines, omitted: 0 };
  return { lines: lines.slice(0, max), omitted: lines.length - max };
}
