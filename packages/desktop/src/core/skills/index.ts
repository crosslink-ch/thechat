import { invoke } from "@tauri-apps/api/core";
import { homeDir, join } from "@tauri-apps/api/path";
import { builtinSkills } from "./builtin";
import { parseFrontmatter } from "./parse";
import type { SkillMeta, SkillInfo } from "./types";

export type { SkillMeta, SkillInfo };

// --- Filesystem helpers ---

interface GlobResult {
  files: string[];
  count: number;
  truncated: boolean;
}

interface ReadFileResult {
  content: string;
  total_lines: number;
  lines_read: number;
  truncated: boolean;
}

async function globFiles(pattern: string, path: string): Promise<string[]> {
  try {
    const result = await invoke<GlobResult>("fs_glob", { pattern, path });
    return result.files;
  } catch {
    return [];
  }
}

async function readFile(filePath: string): Promise<string | null> {
  try {
    const result = await invoke<ReadFileResult>("fs_read_file", {
      filePath,
    });
    return result.content;
  } catch {
    return null;
  }
}

async function getCwd(): Promise<string> {
  try {
    return await invoke<string>("get_cwd");
  } catch {
    return ".";
  }
}

// --- Skill cache ---

let cachedSkills: Map<string, SkillMeta> | null = null;

/**
 * Discover all available skills from built-in sources and filesystem paths.
 * Returns deduplicated list — later sources override earlier on name collision.
 */
export async function discoverSkills(): Promise<SkillMeta[]> {
  const skills = new Map<string, SkillMeta>();

  // 1. Built-in skills (lowest priority)
  for (const skill of builtinSkills) {
    skills.set(skill.name, {
      name: skill.name,
      description: skill.description,
      location: skill.location,
    });
  }

  // 2. Filesystem discovery
  let home: string;
  try {
    home = await homeDir();
  } catch {
    home = "";
  }

  const cwd = (await getCwd()).trim();

  const searchPaths: string[] = [];

  if (home) {
    searchPaths.push(
      await join(home, ".config", "thechat", "skills"),
      await join(home, ".agents", "skills"),
      await join(home, ".claude", "skills"),
    );
  }

  if (cwd && cwd !== ".") {
    searchPaths.push(
      await join(cwd, ".thechat", "skills"),
      await join(cwd, ".agents", "skills"),
      await join(cwd, ".claude", "skills"),
    );
  }

  for (const basePath of searchPaths) {
    const files = await globFiles("**/SKILL.md", basePath);
    for (const filePath of files) {
      const raw = await readFile(filePath);
      if (!raw) continue;

      const { data } = parseFrontmatter(raw);
      if (!data.name || !data.description) continue;

      const name = typeof data.name === "string" ? data.name : data.name[0];
      const description =
        typeof data.description === "string" ? data.description : data.description[0];

      const mcpServers = Array.isArray(data.mcpServers)
        ? data.mcpServers
        : typeof data.mcpServers === "string"
          ? [data.mcpServers]
          : undefined;

      skills.set(name, {
        name,
        description,
        location: filePath,
        ...(mcpServers && mcpServers.length > 0 ? { mcpServers } : {}),
      });
    }
  }

  cachedSkills = skills;
  return Array.from(skills.values());
}

/**
 * Get all discovered skills. Triggers discovery if cache is empty.
 */
export async function getAllSkills(): Promise<SkillMeta[]> {
  if (cachedSkills) {
    return Array.from(cachedSkills.values());
  }
  return discoverSkills();
}

/**
 * Clear the skill cache and re-discover.
 */
export async function refreshSkills(): Promise<SkillMeta[]> {
  cachedSkills = null;
  return discoverSkills();
}

/**
 * Load the full content of a skill by name.
 * Built-in skills return embedded content; filesystem skills read from disk.
 */
export async function loadSkill(name: string): Promise<SkillInfo | null> {
  // Ensure cache is populated
  if (!cachedSkills) {
    await discoverSkills();
  }

  const meta = cachedSkills!.get(name);
  if (!meta) return null;

  // Built-in: return from embedded content
  const builtin = builtinSkills.find((s) => s.name === name);
  if (builtin) {
    return builtin;
  }

  // Filesystem: read full file
  const raw = await readFile(meta.location);
  if (!raw) return null;

  const { content } = parseFrontmatter(raw);
  return {
    ...meta,
    content,
  };
}
