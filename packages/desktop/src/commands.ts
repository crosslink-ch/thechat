import { create } from "zustand";
import { togglePalette, closePalette, closePaletteAndRefocus, openPaletteInCommandMode } from "./CommandPalette";
import { toggleSidebar } from "./components/Sidebar";
import { openWorkspaceModal } from "./components/WorkspaceModal";
import { openHermesBotModal } from "./components/HermesBotModal";
import { openPermissionModePicker } from "./PermissionModePicker";
import { openMcpConfigDialog } from "./McpConfigDialog";
import { useWorkspacesStore } from "./stores/workspaces";
import { useFontSizeStore } from "./stores/font-size";

export interface Keybinding {
  key: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  prefix?: string;
}

export interface Command {
  id: string;
  label: string;
  shortcut: string | null;
  keybinding: Keybinding | null;
  hidden?: boolean;
  enabled?: boolean;
  priority?: number;
  execute: () => void;
}

interface CommandsStore {
  globalCommands: Command[];
  scopedCommands: Record<string, Command[]>;
  commands: Command[];
  setCommands: (c: Command[]) => void;
  registerScopedCommands: (ownerId: string, commands: Command[]) => void;
  unregisterScopedCommands: (ownerId: string) => void;
}

function resolveCommands(
  globalCommands: Command[],
  scopedCommands: Record<string, Command[]>,
) {
  const scoped = Object.values(scopedCommands).flat();

  return [
    ...scoped.map((command, index) => ({
      command,
      order: index,
      priority: command.priority ?? 50,
    })),
    ...globalCommands.map((command, index) => ({
      command,
      order: scoped.length + index,
      priority: command.priority ?? 0,
    })),
  ]
    .filter(({ command }) => command.enabled !== false)
    .sort((a, b) => b.priority - a.priority || a.order - b.order)
    .map(({ command }) => command);
}

export const useCommandsStore = create<CommandsStore>()((set) => ({
  globalCommands: [],
  scopedCommands: {},
  commands: [],
  setCommands: (globalCommands) =>
    set((state) => ({
      globalCommands,
      commands: resolveCommands(globalCommands, state.scopedCommands),
    })),
  registerScopedCommands: (ownerId, commands) =>
    set((state) => {
      const scopedCommands = { ...state.scopedCommands, [ownerId]: commands };
      return {
        scopedCommands,
        commands: resolveCommands(state.globalCommands, scopedCommands),
      };
    }),
  unregisterScopedCommands: (ownerId) =>
    set((state) => {
      const { [ownerId]: _removed, ...scopedCommands } = state.scopedCommands;
      return {
        scopedCommands,
        commands: resolveCommands(state.globalCommands, scopedCommands),
      };
    }),
}));

export function createCommands(
  navigate: (opts: {
    to: string;
    params?: Record<string, string>;
    search?: Record<string, string | undefined>;
  }) => void,
): Command[] {
  return [
    {
      id: "toggle-palette",
      label: "Command Palette",
      shortcut: "Ctrl+P",
      keybinding: { key: "p", ctrl: true },
      hidden: true,
      execute: () => {
        togglePalette();
      },
    },
    {
      id: "command-mode",
      label: "Command Mode",
      shortcut: "Ctrl+Shift+P",
      keybinding: { key: "p", ctrl: true, shift: true },
      hidden: true,
      execute: () => {
        openPaletteInCommandMode();
      },
    },
    {
      id: "toggle-sidebar",
      label: "Toggle Sidebar",
      shortcut: null,
      keybinding: null,
      execute: () => {
        toggleSidebar();
        closePaletteAndRefocus();
      },
    },
    {
      id: "create-workspace",
      label: "Create Workspace",
      shortcut: null,
      keybinding: null,
      execute: () => {
        openWorkspaceModal();
        closePalette();
      },
    },
    {
      id: "manage-workspace",
      label: "Manage Workspace",
      shortcut: null,
      keybinding: null,
      execute: () => {
        const ws = useWorkspacesStore.getState().activeWorkspace;
        if (ws) {
          navigate({ to: "/workspace/manage" });
          closePaletteAndRefocus();
        }
      },
    },
    {
      id: "add-hermes-bot",
      label: "Add Hermes Bot",
      shortcut: null,
      keybinding: null,
      execute: () => {
        closePalette();
        openHermesBotModal();
      },
    },
    {
      id: "notifications",
      label: "View Notifications",
      shortcut: null,
      keybinding: null,
      execute: () => {
        navigate({ to: "/notifications" });
        closePaletteAndRefocus();
      },
    },
    {
      id: "settings",
      label: "Settings",
      shortcut: "C-x ,",
      keybinding: { prefix: "C-x", key: "," },
      execute: () => {
        navigate({ to: "/settings" });
        closePaletteAndRefocus();
      },
    },
    ...(import.meta.env.DEV
      ? [
          {
            id: "debug-scroll",
            label: "Scroll Debug",
            shortcut: null,
            keybinding: null,
            execute: () => {
              navigate({ to: "/debug/scroll" });
              closePaletteAndRefocus();
            },
          },
          {
            id: "debug-hermes",
            label: "Hermes Debug",
            shortcut: null,
            keybinding: null,
            execute: () => {
              navigate({ to: "/debug/hermes" });
              closePaletteAndRefocus();
            },
          },
        ]
      : []),
    {
      id: "configure-mcp",
      label: "Configure MCP Server",
      shortcut: null,
      keybinding: null,
      execute: () => {
        closePalette();
        openMcpConfigDialog();
      },
    },
    {
      id: "switch-permission-mode",
      label: "Switch Permission Mode",
      shortcut: null,
      keybinding: null,
      execute: () => {
        closePalette();
        openPermissionModePicker();
      },
    },
    {
      id: "zoom-in",
      label: "Increase Font Size",
      shortcut: "Ctrl+=",
      keybinding: { key: "=", ctrl: true },
      hidden: true,
      execute: () => useFontSizeStore.getState().increase(),
    },
    {
      id: "zoom-out",
      label: "Decrease Font Size",
      shortcut: "Ctrl+-",
      keybinding: { key: "-", ctrl: true },
      hidden: true,
      execute: () => useFontSizeStore.getState().decrease(),
    },
    {
      id: "zoom-reset",
      label: "Reset Font Size",
      shortcut: "Ctrl+0",
      keybinding: { key: "0", ctrl: true },
      hidden: true,
      execute: () => useFontSizeStore.getState().reset(),
    },
  ];
}
