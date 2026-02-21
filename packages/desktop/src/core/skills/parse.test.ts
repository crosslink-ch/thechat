import { describe, it, expect } from "vitest";
import { parseFrontmatter } from "./parse";

describe("parseFrontmatter", () => {
  it("parses valid SKILL.md with name and description", () => {
    const raw = `---
name: my-skill
description: A helpful skill
---
# Instructions

Do the thing.
`;
    const result = parseFrontmatter(raw);
    expect(result.data).toEqual({
      name: "my-skill",
      description: "A helpful skill",
    });
    expect(result.content).toBe("# Instructions\n\nDo the thing.\n");
  });

  it("returns empty data when no frontmatter present", () => {
    const raw = "# Just markdown\n\nNo frontmatter here.";
    const result = parseFrontmatter(raw);
    expect(result.data).toEqual({});
    expect(result.content).toBe(raw);
  });

  it("handles description containing colons", () => {
    const raw = `---
name: test-skill
description: This does things: many things
---
Content here.
`;
    const result = parseFrontmatter(raw);
    expect(result.data.name).toBe("test-skill");
    expect(result.data.description).toBe("This does things: many things");
  });

  it("handles Windows line endings", () => {
    const raw = "---\r\nname: win-skill\r\ndescription: Windows skill\r\n---\r\nContent.\r\n";
    const result = parseFrontmatter(raw);
    expect(result.data.name).toBe("win-skill");
    expect(result.data.description).toBe("Windows skill");
    expect(result.content).toBe("Content.\r\n");
  });

  it("ignores comment lines in frontmatter", () => {
    const raw = `---
# This is a comment
name: commented
description: Has comments
---
Body.
`;
    const result = parseFrontmatter(raw);
    expect(result.data.name).toBe("commented");
    expect(result.data.description).toBe("Has comments");
  });

  it("handles empty frontmatter block", () => {
    const raw = `---
---
Just content.
`;
    const result = parseFrontmatter(raw);
    expect(result.data).toEqual({});
    expect(result.content).toBe("Just content.\n");
  });
});
