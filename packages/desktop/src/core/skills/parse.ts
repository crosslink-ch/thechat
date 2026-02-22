/**
 * Minimal YAML frontmatter parser.
 * No external dependencies — avoids Node-specific bundling issues with Vite.
 *
 * Supports:
 * - Simple `key: value` string pairs
 * - YAML lists for specific keys (inline `[a, b]` and multi-line `- item`)
 */

export interface ParsedFrontmatter {
  data: Record<string, string | string[]>;
  content: string;
}

const FRONTMATTER_RE = /^---[ \t]*\r?\n([\s\S]*?)---[ \t]*\r?\n([\s\S]*)$/;

export function parseFrontmatter(raw: string): ParsedFrontmatter {
  const match = raw.match(FRONTMATTER_RE);
  if (!match) {
    return { data: {}, content: raw };
  }

  const [, yamlBlock, content] = match;
  const data: Record<string, string | string[]> = {};
  const lines = yamlBlock.split(/\r?\n/);

  let currentKey: string | null = null;
  let currentList: string[] | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    // Check if this is a list item (starts with "- ")
    if (trimmed.startsWith("- ") && currentKey && currentList) {
      currentList.push(trimmed.slice(2).trim());
      continue;
    }

    // Flush any pending list
    if (currentKey && currentList) {
      data[currentKey] = currentList;
      currentKey = null;
      currentList = null;
    }

    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) continue;

    const key = trimmed.slice(0, colonIdx).trim();
    const value = trimmed.slice(colonIdx + 1).trim();
    if (!key) continue;

    // Check for inline YAML list: [a, b, c]
    if (value.startsWith("[") && value.endsWith("]")) {
      const items = value
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      data[key] = items;
      continue;
    }

    // Empty value after colon — could be start of a multi-line list
    if (!value) {
      currentKey = key;
      currentList = [];
      continue;
    }

    data[key] = value;
  }

  // Flush any pending list at end
  if (currentKey && currentList) {
    data[currentKey] = currentList;
  }

  return { data, content };
}
