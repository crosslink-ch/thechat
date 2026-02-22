export interface SkillMeta {
  name: string;
  description: string;
  location: string; // absolute path to SKILL.md, or "builtin"
  mcpServers?: string[]; // MCP server names to load on activation
}

export interface SkillInfo extends SkillMeta {
  content: string; // markdown body after frontmatter
}
