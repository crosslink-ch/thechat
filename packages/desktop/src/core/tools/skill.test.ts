import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/path", () => ({
  homeDir: vi.fn(),
}));

vi.mock("../skills", () => ({
  loadSkill: vi.fn(),
}));

import { loadSkill } from "../skills";
import { createSkillTool } from "./skill";
import type { SkillMeta } from "../skills/types";

const mockLoadSkill = vi.mocked(loadSkill);

beforeEach(() => {
  vi.clearAllMocks();
});

const sampleSkills: SkillMeta[] = [
  { name: "skill-a", description: "Does A things", location: "/path/to/a/SKILL.md" },
  { name: "skill-b", description: "Does B things", location: "builtin" },
];

describe("createSkillTool", () => {
  it("creates a tool named 'skill'", () => {
    const tool = createSkillTool(sampleSkills);
    expect(tool.name).toBe("skill");
  });

  it("lists available skills in description", () => {
    const tool = createSkillTool(sampleSkills);
    expect(tool.description).toContain("<available_skills>");
    expect(tool.description).toContain("<name>skill-a</name>");
    expect(tool.description).toContain("<description>Does A things</description>");
    expect(tool.description).toContain("<name>skill-b</name>");
    expect(tool.description).toContain("</available_skills>");
  });

  it("shows 'No skills' when empty", () => {
    const tool = createSkillTool([]);
    expect(tool.description).toContain("No skills are currently available");
    expect(tool.description).not.toContain("<available_skills>");
  });

  it("returns skill_content block for valid skill name", async () => {
    mockLoadSkill.mockResolvedValueOnce({
      name: "skill-a",
      description: "Does A things",
      location: "/path/to/a/SKILL.md",
      content: "# Skill A\n\nDo the A thing.",
    });

    const tool = createSkillTool(sampleSkills);
    const result = (await tool.execute({ name: "skill-a" })) as any;

    expect(result.success).toBe(true);
    expect(result.output).toContain('<skill_content name="skill-a">');
    expect(result.output).toContain("# Skill: skill-a");
    expect(result.output).toContain("Do the A thing.");
    expect(result.output).toContain("</skill_content>");
    expect(result.output).toContain("Base directory for this skill: /path/to/a");
  });

  it("returns error for unknown skill name", async () => {
    mockLoadSkill.mockResolvedValueOnce(null);

    const tool = createSkillTool(sampleSkills);
    const result = (await tool.execute({ name: "unknown" })) as any;

    expect(result.success).toBe(false);
    expect(result.error).toContain('"unknown" not found');
    expect(result.error).toContain("skill-a");
    expect(result.error).toContain("skill-b");
  });

  it("shows 'builtin' as base directory for built-in skills", async () => {
    mockLoadSkill.mockResolvedValueOnce({
      name: "skill-b",
      description: "Does B things",
      location: "builtin",
      content: "# Built-in skill content",
    });

    const tool = createSkillTool(sampleSkills);
    const result = (await tool.execute({ name: "skill-b" })) as any;

    expect(result.success).toBe(true);
    expect(result.output).toContain("Base directory for this skill: builtin");
  });
});
