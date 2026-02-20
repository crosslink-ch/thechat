import { invoke } from "@tauri-apps/api/core";
import { defineTool } from "./define";

interface ListDirResult {
  tree: string;
  count: number;
  truncated: boolean;
}

export const listTool = defineTool({
  name: "list",
  description: `List directory contents in a tree format. Automatically ignores common directories
(node_modules, .git, dist, build, target, __pycache__, etc.).
Max 100 entries by default.
Use this tool instead of ls or tree shell commands.`,
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Directory path to list. Default: current working directory",
      },
      ignore: {
        type: "array",
        items: { type: "string" },
        description: "Additional directory/file names to ignore",
      },
    },
    required: [],
  },
  execute: async (args) => {
    const { path, ignore } = args as {
      path?: string;
      ignore?: string[];
    };

    const result = await invoke<ListDirResult>("fs_list_dir", {
      path: path ?? undefined,
      ignore: ignore ?? undefined,
    });

    return result;
  },
});
