import { create } from "zustand";
import { togglePalette, closePalette, openPaletteInCommandMode } from "./CommandPalette";
import { toggleSidebar } from "./components/Sidebar";
import { openAuthModal } from "./components/AuthModal";
import { openWorkspaceModal } from "./components/WorkspaceModal";
import { getAgentChatProjectDir } from "./components/ChatHeader";
import { resetTodos } from "./core/todo";

let _pendingProjectDir: string | null = null;
export function consumePendingProjectDir(): string | null {
  const dir = _pendingProjectDir;
  _pendingProjectDir = null;
  return dir;
}

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

export function createCommands(
  navigate: (opts: { to: string; params?: Record<string, string> }) => void,
): Command[] {
  return [
    {
      id: "new-chat",
      label: "New Chat",
      shortcut: "C-x n",
      keybinding: { prefix: "C-x", key: "n" },
      execute: () => {
        resetTodos();
        navigate({ to: "/chat" });
        closePalette();
      },
    },
    {
      id: "new-chat-in-project",
      label: "New Chat in Project",
      shortcut: "C-x c n",
      keybinding: { prefix: "C-x c", key: "n" },
      execute: () => {
        _pendingProjectDir = getAgentChatProjectDir();
        resetTodos();
        navigate({ to: "/chat" });
        closePalette();
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
        closePalette();
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
        closePalette();
      },
    },
  ];
}
