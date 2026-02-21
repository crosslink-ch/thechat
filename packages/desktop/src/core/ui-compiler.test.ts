import { describe, it, expect, beforeEach } from "vitest";
import { compileTsx, clearCompileCache } from "./ui-compiler";

beforeEach(() => {
  clearCompileCache();
});

describe("compileTsx", () => {
  it("compiles a simple component", () => {
    const result = compileTsx(`function Component() { return React.createElement("div", null, "Hello"); }`);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(typeof result.Component).toBe("function");
    }
  });

  it("compiles JSX syntax", () => {
    const result = compileTsx(`function Component() { return <div>Hello JSX</div>; }`);
    expect(result.ok).toBe(true);
  });

  it("compiles component with hooks", () => {
    const result = compileTsx(`
function Component() {
  const [count, setCount] = useState(0);
  return <button onClick={() => setCount(c => c + 1)}>Count: {count}</button>;
}
    `);
    expect(result.ok).toBe(true);
  });

  it("returns error for syntax errors", () => {
    const result = compileTsx(`function Component() { return <div>`);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Compilation error");
    }
  });

  it("returns error when Component is not defined", () => {
    const result = compileTsx(`function NotComponent() { return null; }`);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Component is not defined");
    }
  });

  it("caches results for same code", () => {
    const code = `function Component() { return <div>Cached</div>; }`;
    const result1 = compileTsx(code);
    const result2 = compileTsx(code);
    expect(result1).toBe(result2); // Same reference = cached
  });

  it("handles TypeScript syntax", () => {
    const result = compileTsx(`
function Component() {
  const items: string[] = ["a", "b", "c"];
  return <ul>{items.map((item: string, i: number) => <li key={i}>{item}</li>)}</ul>;
}
    `);
    expect(result.ok).toBe(true);
  });

  it("returns error for runtime errors in factory", () => {
    const result = compileTsx(`
const x = undefinedVar.property;
function Component() { return <div>{x}</div>; }
    `);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Runtime error");
    }
  });
});
