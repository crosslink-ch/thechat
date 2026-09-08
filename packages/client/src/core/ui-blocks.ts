export type TextSegment =
  | { type: "text"; content: string }
  | { type: "ui"; code: string }
  | { type: "ui-pending"; code: string };

const OPEN_FENCE = /^```tsx\s+ui\s*$/m;
const CLOSE_FENCE = /^```\s*$/m;

export function parseTextSegments(text: string): TextSegment[] {
  const segments: TextSegment[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    const openMatch = OPEN_FENCE.exec(remaining);
    if (!openMatch) {
      segments.push({ type: "text", content: remaining });
      break;
    }

    // Text before the opening fence
    if (openMatch.index > 0) {
      segments.push({ type: "text", content: remaining.slice(0, openMatch.index) });
    }

    // Content after the opening fence line
    const codeStart = openMatch.index + openMatch[0].length + 1; // +1 for newline
    const afterFence = remaining.slice(codeStart);

    const closeMatch = CLOSE_FENCE.exec(afterFence);
    if (!closeMatch) {
      // No closing fence — pending block (streaming)
      segments.push({ type: "ui-pending", code: afterFence });
      break;
    }

    // Complete UI block
    const code = afterFence.slice(0, closeMatch.index);
    segments.push({ type: "ui", code: code.trim() });

    // Continue after the closing fence
    remaining = afterFence.slice(closeMatch.index + closeMatch[0].length);
    // Strip leading newline after closing fence
    if (remaining.startsWith("\n")) {
      remaining = remaining.slice(1);
    }
  }

  return segments.filter(
    (s) => !(s.type === "text" && s.content === "")
  );
}
