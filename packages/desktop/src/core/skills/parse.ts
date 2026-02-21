/**
 * Minimal YAML frontmatter parser.
 * No external dependencies — avoids Node-specific bundling issues with Vite.
 */

export interface ParsedFrontmatter {
  data: Record<string, string>;
  content: string;
}

const FRONTMATTER_RE = /^---[ \t]*\r?\n([\s\S]*?)---[ \t]*\r?\n([\s\S]*)$/;

export function parseFrontmatter(raw: string): ParsedFrontmatter {
  const match = raw.match(FRONTMATTER_RE);
  if (!match) {
    return { data: {}, content: raw };
  }

  const [, yamlBlock, content] = match;
  const data: Record<string, string> = {};

  for (const line of yamlBlock.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) continue;

    const key = trimmed.slice(0, colonIdx).trim();
    const value = trimmed.slice(colonIdx + 1).trim();
    if (key) {
      data[key] = value;
    }
  }

  return { data, content };
}
