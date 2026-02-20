import { describe, it, expect } from "vitest";
import { truncateToolResult } from "./truncate";

describe("truncateToolResult", () => {
  it("returns short content unchanged", () => {
    const content = "hello world";
    expect(truncateToolResult(content)).toBe(content);
  });

  it("truncates content exceeding max lines", () => {
    const lines = Array.from({ length: 3000 }, (_, i) => `line ${i}`);
    const content = lines.join("\n");
    const result = truncateToolResult(content);

    const resultLines = result.split("\n");
    // First 2000 lines + blank + truncation message
    expect(resultLines.length).toBeLessThan(3000);
    expect(result).toContain("truncated 1000 lines");
  });

  it("truncates content exceeding max bytes", () => {
    // Create content that's under 2000 lines but over 50KB
    const longLine = "x".repeat(60000);
    const result = truncateToolResult(longLine);

    expect(result.length).toBeLessThan(longLine.length);
    expect(result).toContain("truncated, output too large");
  });

  it("preserves content within limits", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`);
    const content = lines.join("\n");
    expect(truncateToolResult(content)).toBe(content);
  });
});
