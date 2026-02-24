import { invoke } from "@tauri-apps/api/core";
import { loadSkill } from "../skills";
import { defineTool } from "./define";
import type { SkillMeta } from "../skills/types";
import type { McpToolInfo, ToolDefinition } from "../types";

/**
 * Create a skill tool whose description dynamically lists available skills.
 */
export function createSkillTool(skills: SkillMeta[]): ToolDefinition {
  const skillsXml =
    skills.length > 0
      ? [
          "",
          "<available_skills>",
          ...skills.flatMap((s) => {
            const lines = [
              "  <skill>",
              `    <name>${s.name}</name>`,
              `    <description>${s.description}</description>`,
            ];
            if (s.mcpServers && s.mcpServers.length > 0) {
              lines.push(
                `    <tools>Activates MCP tools from: ${s.mcpServers.join(", ")}</tools>`,
              );
            }
            lines.push("  </skill>");
            return lines;
          }),
          "</available_skills>",
        ].join("\n")
      : "\n\nNo skills are currently available.";

  return defineTool({
    name: "skill",
    description: `Load a specialized skill that provides domain-specific instructions and context for a particular task.
When you recognize that a task matches an available skill, use this tool to load it before proceeding.
The skill content will contain detailed instructions for how to handle the task.
Some skills also activate additional MCP tools that become available after loading.
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

      // Initialize MCP servers if the skill declares them
      let newToolNames: string[] = [];
      if (skill.mcpServers && skill.mcpServers.length > 0) {
        try {
          // Get auth token if available (lazy import to avoid circular deps)
          const { useAuthStore } = await import("../../stores/auth");
          const token = useAuthStore.getState().token;

          const toolInfos = await invoke<McpToolInfo[]>("mcp_initialize_servers", {
            names: skill.mcpServers,
            token,
          });
          newToolNames = toolInfos.map((t) => `${t.server}__${t.name}`);

          // Add tools to the active conversation's session (not globally)
          if (toolInfos.length > 0) {
            const { useToolsStore } = await import("../../stores/tools");
            const activeConvId = useToolsStore.getState().activeConvId;
            if (activeConvId) {
              useToolsStore.getState().addSessionMcpTools(activeConvId, toolInfos);
            }
          }
        } catch (e) {
          // Non-fatal: skill content is still useful even if MCP servers fail
          console.error("Failed to initialize MCP servers for skill:", e);
        }
      }

      const baseDir =
        skill.location === "builtin"
          ? "builtin"
          : skill.location.replace(/[/\\][^/\\]*$/, "");

      const outputParts = [
        `<skill_content name="${skill.name}">`,
        `# Skill: ${skill.name}`,
        "",
        skill.content.trim(),
        "",
        `Base directory for this skill: ${baseDir}`,
        "Relative paths in this skill are relative to this base directory.",
        "</skill_content>",
      ];

      if (newToolNames.length > 0) {
        outputParts.push(
          "",
          `<newly_available_tools>`,
          `The following ${newToolNames.length} tools are now available for use:`,
          ...newToolNames.map((n) => `  - ${n}`),
          `</newly_available_tools>`,
        );
      }

      return { success: true, output: outputParts.join("\n") };
    },
  });
}
