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
  /** MCP tools loaded eagerly at startup (always available) */
  mcpTools: ToolDefinition[];
  /** MCP tools loaded lazily via skills (per-conversation session) */
  sessionMcpTools: ToolDefinition[];
  skills: SkillMeta[];
  tools: ToolDefinition[];
  initializeMcp: () => void;
  initializeAuthMcp: (token: string) => void;
  discoverSkills: () => Promise<void>;
  initializeTaskRunner: () => Promise<void>;
  /** Add MCP tools to the current session (loaded by a skill). */
  addSessionMcpTools: (infos: McpToolInfo[]) => void;
  /** Clear session MCP tools (called when starting a new conversation). */
  clearSessionMcpTools: () => void;
}

function mcpInfoToToolDef(info: McpToolInfo): ToolDefinition {
  return {
    name: `${info.server}__${info.name}`,
    description: info.description,
    parameters: info.input_schema as Record<string, unknown>,
    execute: (args: Record<string, unknown>) =>
      invoke<string>("mcp_call_tool", {
        server: info.server,
        tool: info.name,
        args,
      }),
  };
}

function computeTools(
  skills: SkillMeta[],
  mcpTools: ToolDefinition[],
  sessionMcpTools: ToolDefinition[],
): ToolDefinition[] {
  const skillTool = skills.length > 0 ? createSkillTool(skills) : null;
  return [
    ...builtinTools,
    ...(skillTool ? [skillTool] : []),
    ...mcpTools,
    ...sessionMcpTools,
  ];
}

let mcpUnlisten: (() => void) | null = null;

export const useToolsStore = create<ToolsStore>()((set, get) => ({
  mcpTools: [],
  sessionMcpTools: [],
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
      const newTools: ToolDefinition[] = event.payload.map(mcpInfoToToolDef);

      set((state) => {
        const existing = new Set(state.mcpTools.map((t) => t.name));
        const unique = newTools.filter((t) => !existing.has(t.name));
        if (unique.length === 0) return state;
        const mcpTools = [...state.mcpTools, ...unique];
        const tools = computeTools(state.skills, mcpTools, state.sessionMcpTools);
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

  initializeAuthMcp: (token: string) => {
    invoke("mcp_initialize_authed", { token }).catch((e) =>
      console.error("Auth MCP initialization failed:", e),
    );
  },

  discoverSkills: async () => {
    try {
      const skills = await discoverSkills();
      set((state) => {
        const tools = computeTools(skills, state.mcpTools, state.sessionMcpTools);
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

  addSessionMcpTools: (infos: McpToolInfo[]) => {
    const newTools = infos.map(mcpInfoToToolDef);
    set((state) => {
      const existing = new Set(state.sessionMcpTools.map((t) => t.name));
      const unique = newTools.filter((t) => !existing.has(t.name));
      if (unique.length === 0) return state;
      const sessionMcpTools = [...state.sessionMcpTools, ...unique];
      const tools = computeTools(state.skills, state.mcpTools, sessionMcpTools);
      return { sessionMcpTools, tools };
    });
  },

  clearSessionMcpTools: () => {
    set((state) => {
      if (state.sessionMcpTools.length === 0) return state;
      const tools = computeTools(state.skills, state.mcpTools, []);
      return { sessionMcpTools: [], tools };
    });
  },
}));
