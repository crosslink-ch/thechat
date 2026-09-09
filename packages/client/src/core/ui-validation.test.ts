import { describe, it, expect, beforeEach } from "vitest";
import { validateUiBlocks, formatUiErrorsForLlm } from "./ui-validation";
import { clearCompileCache } from "./ui-compiler";

beforeEach(() => {
  clearCompileCache();
});

describe("validateUiBlocks", () => {
  it("returns no errors for text without ui blocks", () => {
    expect(validateUiBlocks("Just some regular markdown text.")).toEqual([]);
  });

  it("returns no errors for a valid component", () => {
    const text = `Here's a chart:
\`\`\`tsx ui
function Component() {
  return <div>Hello</div>;
}
\`\`\``;
    expect(validateUiBlocks(text)).toEqual([]);
  });

  it("returns no errors for a component that uses hooks", () => {
    const text = `\`\`\`tsx ui
function Component() {
  const [n, setN] = useState(0);
  return <button onClick={() => setN(n + 1)}>{n}</button>;
}
\`\`\``;
    expect(validateUiBlocks(text)).toEqual([]);
  });

  it("reports a syntax error", () => {
    const text = `\`\`\`tsx ui
function Component() { return <div>
\`\`\``;
    const errors = validateUiBlocks(text);
    expect(errors).toHaveLength(1);
    expect(errors[0].error).toContain("Compilation error");
  });

  it("reports a missing Component function", () => {
    const text = `\`\`\`tsx ui
function Other() { return <div>oops</div>; }
\`\`\``;
    const errors = validateUiBlocks(text);
    expect(errors).toHaveLength(1);
    expect(errors[0].error).toContain("Component is not defined");
  });

  it("reports a factory-time runtime error", () => {
    const text = `\`\`\`tsx ui
const x = undefinedGlobal.something;
function Component() { return <div>{x}</div>; }
\`\`\``;
    const errors = validateUiBlocks(text);
    expect(errors).toHaveLength(1);
    expect(errors[0].error).toContain("Runtime error");
  });

  it("catches render-time errors via headless mount", () => {
    const text = `\`\`\`tsx ui
function Component() {
  throw new Error("kaboom");
}
\`\`\``;
    const errors = validateUiBlocks(text);
    expect(errors).toHaveLength(1);
    expect(errors[0].error).toContain("kaboom");
  });

  it("catches errors from accessing undefined props during render", () => {
    const text = `\`\`\`tsx ui
function Component() {
  const data: any = null;
  return <div>{data.name}</div>;
}
\`\`\``;
    const errors = validateUiBlocks(text);
    expect(errors).toHaveLength(1);
    expect(errors[0].error).toMatch(/null|undefined|Render error/i);
  });

  it("returns multiple errors for multiple broken blocks", () => {
    const text = `\`\`\`tsx ui
function Component() { return <div>ok</div>; }
\`\`\`

\`\`\`tsx ui
function Component() { throw new Error("second broken"); }
\`\`\`

\`\`\`tsx ui
function Other() { return null; }
\`\`\``;
    const errors = validateUiBlocks(text);
    expect(errors).toHaveLength(2);
    expect(errors[0].error).toContain("second broken");
    expect(errors[1].error).toContain("Component is not defined");
  });

  it("ignores pending (unclosed) ui blocks", () => {
    const text = `\`\`\`tsx ui
function Component() { return <div>still writing`;
    expect(validateUiBlocks(text)).toEqual([]);
  });
});

describe("formatUiErrorsForLlm", () => {
  it("includes error and offending code for each block", () => {
    const msg = formatUiErrorsForLlm([
      { code: "function Component() { throw 'x'; }", error: "Render error: x" },
    ]);
    expect(msg).toContain("Render error: x");
    expect(msg).toContain("function Component()");
    expect(msg).toContain("```tsx");
  });

  it("instructs the model to deliver a corrected response silently", () => {
    const msg = formatUiErrorsForLlm([{ code: "x", error: "y" }]);
    expect(msg.toLowerCase()).toContain("corrected");
    expect(msg.toLowerCase()).toContain("do not apologize");
  });
});
