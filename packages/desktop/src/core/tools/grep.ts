import { invoke } from "@tauri-apps/api/core";
import { defineTool } from "./define";

interface GrepMatch {
  file: string;
  line: number;
  text: string;
}

interface GrepResult {
  matches: GrepMatch[];
  count: number;
  truncated: boolean;
}

export const grepTool = defineTool({
  name: "grep",
  description: `Search file contents using a regex pattern. Returns matching lines with file paths and line numbers.
Automatically skips binary files and common ignored directories (node_modules, .git, dist, etc.).
Max 100 matches by default.
Use this tool instead of grep or rg shell commands.`,
  parameters: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "Regex pattern to search for in file contents",
      },
      path: {
        type: "string",
        description: "Directory or file to search in. Default: current working directory",
      },
      include: {
        type: "string",
        description: 'File extension filter (e.g. "*.ts", "*.rs"). Only search files with this extension.',
      },
    },
    required: ["pattern"],
  },
  execute: async (args) => {
    const { pattern, path, include } = args as {
      pattern: string;
      path?: string;
      include?: string;
    };

    const result = await invoke<GrepResult>("fs_grep", {
      pattern,
      path: path ?? undefined,
      include: include ?? undefined,
    });

    return result;
  },
});
