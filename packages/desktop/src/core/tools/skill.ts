import { loadSkill } from "../skills";
import { defineTool } from "./define";
import type { SkillMeta } from "../skills/types";
import type { ToolDefinition } from "../types";

/**
 * Create a skill tool whose description dynamically lists available skills.
 */
export function createSkillTool(skills: SkillMeta[]): ToolDefinition {
  const skillsXml =
    skills.length > 0
      ? [
          "",
          "<available_skills>",
          ...skills.flatMap((s) => [
            "  <skill>",
            `    <name>${s.name}</name>`,
            `    <description>${s.description}</description>`,
            "  </skill>",
          ]),
          "</available_skills>",
        ].join("\n")
      : "\n\nNo skills are currently available.";

  return defineTool({
    name: "skill",
    description: `Load a specialized skill that provides domain-specific instructions and context for a particular task.
When you recognize that a task matches an available skill, use this tool to load it before proceeding.
The skill content will contain detailed instructions for how to handle the task.
${skillsXml}`,
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "The name of the skill to load",
        },
      },
      required: ["name"],
    },
    execute: async (args) => {
      const { name } = args as { name: string };

      const skill = await loadSkill(name);
      if (!skill) {
        const available = skills.map((s) => s.name).join(", ");
        return {
          success: false,
          error: `Skill "${name}" not found. Available skills: ${available || "none"}`,
        };
      }

      const baseDir =
        skill.location === "builtin"
          ? "builtin"
          : skill.location.replace(/\/[^/]*$/, "");

      const output = [
        `<skill_content name="${skill.name}">`,
        `# Skill: ${skill.name}`,
        "",
        skill.content.trim(),
        "",
        `Base directory for this skill: ${baseDir}`,
        "Relative paths in this skill are relative to this base directory.",
        "</skill_content>",
      ].join("\n");

      return { success: true, output };
    },
  });
}
