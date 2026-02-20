import { describe, it, expect } from "vitest";
import { invalidTool } from "./invalid";

describe("invalidTool", () => {
  it("has correct name", () => {
    expect(invalidTool.name).toBe("invalid");
  });

  it("returns the error message", () => {
    const result = invalidTool.execute({ error: "Tool not found: foo" });
    expect(result).toEqual({ error: "Tool not found: foo" });
  });
});
