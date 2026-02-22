import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  getCurrentTimeTool,
  shellTool,
  readTool,
  writeTool,
  editTool,
  multiEditTool,
  globTool,
  grepTool,
  listTool,
  questionTool,
  batchTool,
  taskTool,
  todoReadTool,
  todoWriteTool,
  listCredentialsTool,
  getCredentialTool,
  invalidTool,
  createSkillTool,
} from "../core/tools/index";
import { discoverSkills } from "../core/skills";
import { setBatchToolRegistry } from "../core/tools/batch";
import { setTaskRunnerConfig } from "../core/task-runner";
import type { ToolDefinition, McpToolInfo, AppConfig } from "../core/types";
import type { SkillMeta } from "../core/skills/types";

const builtinTools: ToolDefinition[] = [
  getCurrentTimeTool,
  shellTool,
  readTool,
  writeTool,
  editTool,
  multiEditTool,
  globTool,
  grepTool,
  listTool,
  questionTool,
  batchTool,
  taskTool,
  todoReadTool,
  todoWriteTool,
  listCredentialsTool,
  getCredentialTool,
  invalidTool,
];

interface ToolsStore {
  mcpTools: ToolDefinition[];
  skills: SkillMeta[];
  tools: ToolDefinition[];
  initializeMcp: () => void;
  discoverSkills: () => Promise<void>;
  initializeTaskRunner: () => Promise<void>;
}

function computeTools(skills: SkillMeta[], mcpTools: ToolDefinition[]): ToolDefinition[] {
  const skillTool = skills.length > 0 ? createSkillTool(skills) : null;
  return [...builtinTools, ...(skillTool ? [skillTool] : []), ...mcpTools];
}

let mcpUnlisten: (() => void) | null = null;

export const useToolsStore = create<ToolsStore>()((set, get) => ({
  mcpTools: [],
  skills: [],
  tools: [...builtinTools],

  initializeMcp: () => {
    // Clean up previous listener
    if (mcpUnlisten) {
      mcpUnlisten();
      mcpUnlisten = null;
    }

    set({ mcpTools: [] });

    const unlistenPromise = listen<McpToolInfo[]>("mcp-tools-ready", (event) => {
      const newTools: ToolDefinition[] = event.payload.map((info) => ({
        name: `${info.server}__${info.name}`,
        description: info.description,
        parameters: info.input_schema as Record<string, unknown>,
        execute: (args: Record<string, unknown>) =>
          invoke<string>("mcp_call_tool", {
            server: info.server,
            tool: info.name,
            args,
          }),
      }));

      set((state) => {
        const existing = new Set(state.mcpTools.map((t) => t.name));
        const unique = newTools.filter((t) => !existing.has(t.name));
        if (unique.length === 0) return state;
        const mcpTools = [...state.mcpTools, ...unique];
        const tools = computeTools(state.skills, mcpTools);
        return { mcpTools, tools };
      });
    });

    unlistenPromise.then((unlisten) => {
      mcpUnlisten = unlisten;
    });

    invoke("mcp_initialize").catch((e) =>
      console.error("MCP initialization failed:", e),
    );
  },

  discoverSkills: async () => {
    try {
      const skills = await discoverSkills();
      set((state) => {
        const tools = computeTools(skills, state.mcpTools);
        return { skills, tools };
      });
    } catch {
      // ignore
    }
  },

  initializeTaskRunner: async () => {
    const { tools } = get();
    setBatchToolRegistry(tools);

    try {
      const config = await invoke<AppConfig>("get_config");
      setTaskRunnerConfig({
        apiKey: config.api_key,
        model: config.model,
        availableTools: tools,
      });
    } catch {
      // ignore
    }
  },
}));
