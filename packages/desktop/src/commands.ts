import { create } from "zustand";
import { togglePalette, closePalette, closePaletteAndRefocus, openPaletteInCommandMode } from "./CommandPalette";
import { toggleSidebar } from "./components/Sidebar";
import { openAuthModal } from "./components/AuthModal";
import { openWorkspaceModal } from "./components/WorkspaceModal";
import { getAgentChatProjectDir } from "./components/ChatHeader";
import { openPermissionModePicker } from "./PermissionModePicker";
import { openSelectProjectPicker } from "./SelectProjectPicker";
import { useConversationsStore } from "./stores/conversations";

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
  execute: () => void;
}

interface CommandsStore {
  commands: Command[];
  setCommands: (c: Command[]) => void;
}

export const useCommandsStore = create<CommandsStore>()((set) => ({
  commands: [],
  setCommands: (commands) => set({ commands }),
}));

function getRecentProjects(): string[] {
  const conversations = useConversationsStore.getState().conversations;
  const seen = new Set<string>();
  const projects: string[] = [];

  for (const conv of conversations) {
    if (!conv.project_dir || seen.has(conv.project_dir)) continue;
    seen.add(conv.project_dir);
    projects.push(conv.project_dir);
  }

  const currentProject = getAgentChatProjectDir();
  if (currentProject && !seen.has(currentProject)) {
    projects.unshift(currentProject);
  }

  return projects;
}

export function createCommands(
  navigate: (opts: {
    to: string;
    params?: Record<string, string>;
    search?: Record<string, string | undefined>;
  }) => void,
): Command[] {
  return [
    {
      id: "new-chat",
      label: "New Chat",
      shortcut: "C-x n",
      keybinding: { prefix: "C-x", key: "n" },
      execute: () => {
        navigate({ to: "/chat" });
        closePaletteAndRefocus();
      },
    },
    {
      id: "new-chat-in-project",
      label: "New Chat in Project",
      shortcut: "C-x c n",
      keybinding: { prefix: "C-x c", key: "n" },
      execute: () => {
        const dir = getAgentChatProjectDir();
        navigate({ to: "/chat", search: dir ? { projectDir: dir } : {} });
        closePaletteAndRefocus();
      },
    },
    {
      id: "select-project",
      label: "Select Project",
      shortcut: "C-x c s",
      keybinding: { prefix: "C-x c", key: "s" },
      execute: () => {
        closePalette();
        openSelectProjectPicker(getRecentProjects(), (projectDir) => {
          navigate({ to: "/chat", search: { projectDir } });
        });
      },
    },
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
      id: "login",
      label: "Log In",
      shortcut: null,
      keybinding: null,
      execute: () => {
        openAuthModal();
        closePalette();
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
  ];
}
