import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { error as logError, warn as logWarn, info as logInfo, formatError } from "../log";
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
  webFetchTool,
  invalidTool,
  createSkillTool,
} from "../core/tools/index";
import { discoverSkills } from "../core/skills";
import { setBatchToolRegistry } from "../core/tools/batch";
import { setTaskRunnerConfig } from "../core/task-runner";
import type { ToolDefinition, McpToolInfo } from "../core/types";
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
  webFetchTool,
  invalidTool,
];

interface ToolsStore {
  /** MCP tools loaded eagerly at startup (always available) */
  mcpTools: ToolDefinition[];
  /** Per-conversation session MCP tool infos (lazy-populated from DB) */
  sessionToolsByConv: Record<string, McpToolInfo[]>;
  /** Currently active conversation ID (whose session tools are active) */
  activeConvId: string | null;
  /** CWD for the active conversation (from project_dir) */
  activeCwd: string | null;
  skills: SkillMeta[];
  tools: ToolDefinition[];
  initializeMcp: () => void;
  initializeAuthMcp: (token: string) => void;
  discoverSkills: () => Promise<void>;
  initializeTaskRunner: () => void;
  /** Set the active conversation, loading its session tools from DB if needed. */
  setActiveConversation: (convId: string | null, projectDir?: string | null) => Promise<void>;
  /** Add MCP tools to a specific conversation's session (loaded by a skill). */
  addSessionMcpTools: (convId: string, infos: McpToolInfo[]) => void;
  /** Add MCP tools to the global (non-session) tool set. Used when configuring new MCP servers. */
  addGlobalMcpTools: (infos: McpToolInfo[]) => void;
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
  sessionMcpInfos: McpToolInfo[],
): ToolDefinition[] {
  const skillTool = skills.length > 0 ? createSkillTool(skills) : null;
  const sessionToolDefs = sessionMcpInfos.map(mcpInfoToToolDef);
  return [
    ...builtinTools,
    ...(skillTool ? [skillTool] : []),
    ...mcpTools,
    ...sessionToolDefs,
  ];
}

/** Get the active conversation's session tool infos from the store state. */
function getActiveSessionInfos(state: ToolsStore): McpToolInfo[] {
  if (!state.activeConvId) return [];
  return state.sessionToolsByConv[state.activeConvId] ?? [];
}

let mcpUnlisten: (() => void) | null = null;

export const useToolsStore = create<ToolsStore>()((set, get) => ({
  mcpTools: [],
  sessionToolsByConv: {},
  activeConvId: null,
  activeCwd: null,
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
        const tools = computeTools(state.skills, mcpTools, getActiveSessionInfos(state));
        setBatchToolRegistry(tools);
        return { mcpTools, tools };
      });
    });

    unlistenPromise.then((unlisten) => {
      mcpUnlisten = unlisten;
    });

    invoke("mcp_initialize").catch((e) =>
      logError(`[tools] MCP initialization failed: ${formatError(e)}`),
    );
  },

  initializeAuthMcp: (token: string) => {
    invoke("mcp_initialize_authed", { token }).catch((e) =>
      logError(`[tools] Auth MCP initialization failed: ${formatError(e)}`),
    );
  },

  discoverSkills: async () => {
    try {
      const skills = await discoverSkills();
      logInfo(`[tools] Discovered ${skills.length} skills`);
      set((state) => {
        const tools = computeTools(skills, state.mcpTools, getActiveSessionInfos(state));
        setBatchToolRegistry(tools);
        return { skills, tools };
      });
    } catch (e) {
      logWarn(`[tools] Skill discovery failed: ${formatError(e)}`);
    }
  },

  initializeTaskRunner: () => {
    const { tools, activeCwd } = get();
    setBatchToolRegistry(tools);
    setTaskRunnerConfig({
      availableTools: tools,
      cwd: activeCwd ?? undefined,
    });
  },

  setActiveConversation: async (convId: string | null, projectDir?: string | null) => {
    set((state) => {
      const tools = computeTools(
        state.skills,
        state.mcpTools,
        convId ? (state.sessionToolsByConv[convId] ?? []) : [],
      );
      setBatchToolRegistry(tools);
      return { activeConvId: convId, activeCwd: projectDir ?? null, tools };
    });

    if (!convId) return;

    // If already cached, try to re-initialize MCP servers in the background
    const state = get();
    const cached = state.sessionToolsByConv[convId];
      if (cached && cached.length > 0) {
        // Fire-and-forget: re-initialize MCP servers for these tools
        const serverNames = [...new Set(cached.map((t) => t.server))];
      invoke("mcp_initialize_servers", { names: serverNames, token: null }).catch((e) =>
        logWarn(`[tools] MCP server re-init failed: ${formatError(e)}`),
      );
      return;
    }

    // Not cached — try loading from kv_store
    try {
      const json = await invoke<string | null>("kv_get", {
        key: `session_tools:${convId}`,
      });
      if (!json) return;

      const infos: McpToolInfo[] = JSON.parse(json);
      if (infos.length === 0) return;

      set((state) => {
        const sessionToolsByConv = {
          ...state.sessionToolsByConv,
          [convId]: infos,
        };
        // Only recompute if this is still the active conversation
        if (state.activeConvId !== convId) return { sessionToolsByConv };
        const tools = computeTools(state.skills, state.mcpTools, infos);
        setBatchToolRegistry(tools);
        return { sessionToolsByConv, tools };
      });

      // Fire-and-forget: re-initialize MCP servers
      const serverNames = [...new Set(infos.map((t) => t.server))];
      invoke("mcp_initialize_servers", { names: serverNames, token: null }).catch((e) =>
        logWarn(`[tools] MCP server re-init failed: ${formatError(e)}`),
      );
    } catch (e) {
      logWarn(`[tools] Session tools DB load failed for conv=${convId}: ${formatError(e)}`);
    }
  },

  addSessionMcpTools: (convId: string, infos: McpToolInfo[]) => {
    set((state) => {
      const existing = state.sessionToolsByConv[convId] ?? [];
      const existingNames = new Set(existing.map((t) => `${t.server}__${t.name}`));
      const unique = infos.filter((t) => !existingNames.has(`${t.server}__${t.name}`));
      if (unique.length === 0) return state;

      const merged = [...existing, ...unique];
      const sessionToolsByConv = { ...state.sessionToolsByConv, [convId]: merged };

      // Persist to kv_store (fire-and-forget)
      invoke("kv_set", {
        key: `session_tools:${convId}`,
        value: JSON.stringify(merged),
      }).catch((e) => logWarn(`[tools] Failed to persist session tools: ${formatError(e)}`));

      // Only recompute tools if this is the active conversation
      if (state.activeConvId !== convId) return { sessionToolsByConv };
      const tools = computeTools(state.skills, state.mcpTools, merged);
      setBatchToolRegistry(tools);
      return { sessionToolsByConv, tools };
    });
  },

  addGlobalMcpTools: (infos: McpToolInfo[]) => {
    const newTools: ToolDefinition[] = infos.map(mcpInfoToToolDef);

    set((state) => {
      const existing = new Set(state.mcpTools.map((t) => t.name));
      const unique = newTools.filter((t) => !existing.has(t.name));
      if (unique.length === 0) return state;
      const mcpTools = [...state.mcpTools, ...unique];
      const tools = computeTools(state.skills, mcpTools, getActiveSessionInfos(state));
      setBatchToolRegistry(tools);
      return { mcpTools, tools };
    });
  },
}));
