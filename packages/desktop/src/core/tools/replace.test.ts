import { describe, it, expect } from "vitest";
import { replace } from "./replace";

describe("replace", () => {
  describe("SimpleReplacer (exact match)", () => {
    it("replaces exact match", () => {
      expect(replace("hello world", "hello", "goodbye")).toBe("goodbye world");
    });

    it("replaces exact multiline match", () => {
      const content = "line1\nline2\nline3";
      expect(replace(content, "line1\nline2", "replaced")).toBe(
        "replaced\nline3",
      );
    });

    it("throws when old and new are identical", () => {
      expect(() => replace("hello", "hello", "hello")).toThrow(
        "identical",
      );
    });

    it("throws when not found at all", () => {
      expect(() => replace("hello world", "nonexistent", "x")).toThrow(
        "Could not find oldString",
      );
    });

    it("throws when multiple matches without replaceAll", () => {
      expect(() => replace("aa", "a", "b")).toThrow(
        "multiple matches",
      );
    });

    it("replaces all with replaceAll=true", () => {
      expect(replace("aXaXa", "a", "b", true)).toBe("bXbXb");
    });
  });

  describe("LineTrimmedReplacer", () => {
    it("matches with different leading whitespace", () => {
      const content = "  function foo() {\n    return 1;\n  }";
      const find = "function foo() {\n  return 1;\n}";
      const result = replace(content, find, "function bar() {\n    return 2;\n  }");
      expect(result).toBe("function bar() {\n    return 2;\n  }");
    });

    it("matches with tabs vs spaces", () => {
      const content = "\tif (true) {\n\t\treturn;\n\t}";
      const find = "if (true) {\n    return;\n}";
      const result = replace(content, find, "replaced");
      expect(result).toBe("replaced");
    });
  });

  describe("BlockAnchorReplacer", () => {
    it("matches block by first/last line anchors with fuzzy middle", () => {
      const content = [
        "function greet() {",
        "  const msg = 'hello';",
        "  console.log(msg);",
        "  return msg;",
        "}",
      ].join("\n");

      const find = [
        "function greet() {",
        "  const message = 'hello';",  // slightly different variable name
        "  console.log(message);",     // slightly different
        "  return message;",           // slightly different
        "}",
      ].join("\n");

      const result = replace(content, find, "function greet() { return 'hi'; }");
      expect(result).toBe("function greet() { return 'hi'; }");
    });
  });

  describe("IndentationFlexibleReplacer", () => {
    it("matches with different indentation levels", () => {
      const content = "    if (x) {\n      return true;\n    }";
      const find = "  if (x) {\n    return true;\n  }";
      const result = replace(content, find, "    if (y) {\n      return false;\n    }");
      expect(result).toBe("    if (y) {\n      return false;\n    }");
    });
  });

  describe("WhitespaceNormalizedReplacer", () => {
    it("matches with extra spaces", () => {
      const content = "const x = 1;";
      const find = "const  x  =  1;";
      const result = replace(content, find, "const y = 2;");
      expect(result).toBe("const y = 2;");
    });
  });

  describe("EscapeNormalizedReplacer", () => {
    it("handles escaped newlines in search", () => {
      const content = "line1\nline2";
      const find = "line1\\nline2";
      const result = replace(content, find, "replaced");
      expect(result).toBe("replaced");
    });
  });

  describe("TrimmedBoundaryReplacer", () => {
    it("matches trimmed content", () => {
      const content = "hello world";
      const find = "  hello world  ";
      const result = replace(content, find, "goodbye");
      expect(result).toBe("goodbye");
    });
  });

  describe("ContextAwareReplacer", () => {
    it("matches by context anchors with 50% similarity threshold", () => {
      const content = [
        "function test() {",
        "  const a = 1;",
        "  const b = 2;",
        "  return a + b;",
        "}",
      ].join("\n");

      const find = [
        "function test() {",
        "  const a = 1;",
        "  const b = 2;",
        "  return a + b;",
        "}",
      ].join("\n");

      // Exact match handled by SimpleReplacer, but ContextAware would also match
      const result = replace(content, find, "function test() { return 3; }");
      expect(result).toBe("function test() { return 3; }");
    });
  });

  describe("cascading fallback", () => {
    it("falls through to the first working strategy", () => {
      // Content has 4-space indentation, search has 2-space
      const content = "    const x = 1;\n    const y = 2;";
      const find = "  const x = 1;\n  const y = 2;";
      const result = replace(content, find, "    const z = 3;");
      expect(result).toBe("    const z = 3;");
    });
  });
});
