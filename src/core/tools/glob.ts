import { invoke } from "@tauri-apps/api/core";
import { defineTool } from "./define";

interface GlobResult {
  files: string[];
  count: number;
  truncated: boolean;
}

export const globTool = defineTool({
  name: "glob",
  description: `Find files matching a glob pattern. Returns file paths sorted by modification time (most recent first).
Supports standard glob patterns like "**/*.ts", "src/**/*.tsx", "*.json".
Max 100 results by default.
Use this tool instead of find or ls for locating files.`,
  parameters: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: 'The glob pattern to match (e.g. "**/*.ts", "src/**/*.tsx")',
      },
      path: {
        type: "string",
        description: "Base directory to search from. Pattern is resolved relative to this.",
      },
    },
    required: ["pattern"],
  },
  execute: async (args) => {
    const { pattern, path } = args as {
      pattern: string;
      path?: string;
    };

    const result = await invoke<GlobResult>("fs_glob", {
      pattern,
      path: path ?? undefined,
    });

    return result;
  },
});
