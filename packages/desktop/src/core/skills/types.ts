export interface SkillMeta {
  name: string;
  description: string;
  location: string; // absolute path to SKILL.md, or "builtin"
}

export interface SkillInfo extends SkillMeta {
  content: string; // markdown body after frontmatter
}
