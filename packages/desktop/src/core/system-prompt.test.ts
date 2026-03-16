import { describe, expect, it, vi, afterEach } from "vitest";
import { buildSystemPrompt } from "./system-prompt";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("buildSystemPrompt", () => {
  it("includes LaTeX formatting guidance", () => {
    vi.stubGlobal("navigator", { platform: "Linux x86_64" });

    const prompt = buildSystemPrompt("/tmp/project", {
      isGit: true,
      gitBranch: "main",
    });

    expect(prompt).toContain("# LaTeX math formatting");
    expect(prompt).toContain("For **inline math**, use double-dollar delimiters");
    expect(prompt).toContain("Do **not** use single-dollar inline math such as `$x$`");
    expect(prompt).toContain("```math");
  });
});
