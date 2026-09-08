import { describe, it, expect } from "vitest";
import { parseTextSegments } from "./ui-blocks";

describe("parseTextSegments", () => {
  it("returns plain text as a single text segment", () => {
    const result = parseTextSegments("Hello world");
    expect(result).toEqual([{ type: "text", content: "Hello world" }]);
  });

  it("parses a complete ui block", () => {
    const input = `Before text
\`\`\`tsx ui
function Component() {
  return <div>Hello</div>;
}
\`\`\`
After text`;

    const result = parseTextSegments(input);
    expect(result).toEqual([
      { type: "text", content: "Before text\n" },
      {
        type: "ui",
        code: 'function Component() {\n  return <div>Hello</div>;\n}',
      },
      { type: "text", content: "After text" },
    ]);
  });

  it("parses an incomplete ui block as ui-pending", () => {
    const input = `Here's a component:
\`\`\`tsx ui
function Component() {
  return <div>Still writing...`;

    const result = parseTextSegments(input);
    expect(result).toEqual([
      { type: "text", content: "Here's a component:\n" },
      {
        type: "ui-pending",
        code: "function Component() {\n  return <div>Still writing...",
      },
    ]);
  });

  it("handles multiple ui blocks", () => {
    const input = `First:
\`\`\`tsx ui
function Component() { return <div>A</div>; }
\`\`\`
Middle text
\`\`\`tsx ui
function Component() { return <div>B</div>; }
\`\`\`
End`;

    const result = parseTextSegments(input);
    expect(result).toEqual([
      { type: "text", content: "First:\n" },
      { type: "ui", code: "function Component() { return <div>A</div>; }" },
      { type: "text", content: "Middle text\n" },
      { type: "ui", code: "function Component() { return <div>B</div>; }" },
      { type: "text", content: "End" },
    ]);
  });

  it("leaves regular tsx code fences as plain text", () => {
    const input = `Here's code:
\`\`\`tsx
const x = 1;
\`\`\`
Done`;

    const result = parseTextSegments(input);
    expect(result).toEqual([
      { type: "text", content: "Here's code:\n```tsx\nconst x = 1;\n```\nDone" },
    ]);
  });

  it("handles empty input", () => {
    expect(parseTextSegments("")).toEqual([]);
  });

  it("handles ui block at the very start", () => {
    const input = `\`\`\`tsx ui
function Component() { return <span>Hi</span>; }
\`\`\``;

    const result = parseTextSegments(input);
    expect(result).toEqual([
      { type: "ui", code: "function Component() { return <span>Hi</span>; }" },
    ]);
  });

  it("handles ui block with extra whitespace in fence", () => {
    const input = `\`\`\`tsx  ui
function Component() { return null; }
\`\`\``;

    const result = parseTextSegments(input);
    expect(result).toEqual([
      { type: "ui", code: "function Component() { return null; }" },
    ]);
  });
});
