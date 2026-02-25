import { useState, useEffect } from "react";
import { create } from "zustand";
import { useMatches } from "@tanstack/react-router";
import { useWebSocketStore } from "../stores/websocket";
import { useWorkspacesStore } from "../stores/workspaces";
import { usePermissionModeStore } from "../stores/permission-mode";
import { toggleSidebar } from "./Sidebar";
import { basename } from "../lib/path";

// Mini-store for agent chat title & project dir (set by agent-chat route)
const useAgentChatTitle = create(() => ({ title: "", projectDir: null as string | null }));
export const setAgentChatTitle = (title: string) =>
  useAgentChatTitle.setState({ title });
export const setAgentChatProjectDir = (projectDir: string | null) =>
  useAgentChatTitle.setState({ projectDir });
export const getAgentChatProjectDir = () => useAgentChatTitle.getState().projectDir;

export function ChatHeader() {
  const connected = useWebSocketStore((s) => s.connected);
  const activeWorkspace = useWorkspacesStore((s) => s.activeWorkspace);
  const permissionMode = usePermissionModeStore((s) => s.mode);
  const agentChatTitle = useAgentChatTitle((s) => s.title);
  const agentProjectDir = useAgentChatTitle((s) => s.projectDir);
  const matches = useMatches();
  const lastMatch = matches[matches.length - 1];
  const routePath = lastMatch?.fullPath ?? "";
  const params = (lastMatch?.params ?? {}) as Record<string, string>;

  const [projectName, setProjectName] = useState<string | null>(null);

  useEffect(() => {
    if (agentProjectDir) {
      basename(agentProjectDir).then(setProjectName);
    } else {
      setProjectName(null);
    }
  }, [agentProjectDir]);

  const isAgentChat = routePath.startsWith("/chat");
  const isChannel = routePath.startsWith("/channel");
  const isDm = routePath.startsWith("/dm");

  let chatTitle = "New Chat";
  if (isAgentChat) {
    chatTitle = agentChatTitle || "New Chat";
  } else if (isChannel) {
    const channelId = params.id;
    const channel = activeWorkspace?.channels.find((ch) => ch.id === channelId);
    chatTitle = channel ? `# ${channel.name}` : "# Channel";
  } else if (isDm) {
    chatTitle = "Direct Message";
  }

  const showBackButton = !isAgentChat;
  const showWsStatus = !isAgentChat && connected;

  return (
    <div className="flex h-12 items-center gap-2.5 border-b border-border-subtle bg-surface px-3">
      <button
        className="flex size-8 cursor-pointer items-center justify-center rounded-md border-none bg-none text-text-muted transition-colors duration-150 hover:bg-hover hover:text-text"
        onClick={toggleSidebar}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <path d="M2.5 4H13.5" />
          <path d="M2.5 8H13.5" />
          <path d="M2.5 12H13.5" />
        </svg>
      </button>
      {showBackButton && (
        <button
          className="flex size-8 cursor-pointer items-center justify-center rounded-md border-none bg-none text-text-muted transition-colors duration-150 hover:bg-hover hover:text-text"
          onClick={() => window.history.back()}
        >
          <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 3L5 7.5L9 12" />
          </svg>
        </button>
      )}
      <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[13px] text-text-muted">{chatTitle}</span>
      {isAgentChat && projectName && (
        <span className="rounded-md bg-elevated px-2 py-0.5 text-[11px] text-text-dimmed" title={agentProjectDir!}>
          {projectName}
        </span>
      )}
      {permissionMode === "allow-edits" && (
        <span className="rounded-md bg-warning-bg px-2 py-0.5 text-[11px] font-medium text-warning-text">
          Allow Edits
        </span>
      )}
      {permissionMode === "bypass" && (
        <span className="rounded-md bg-danger-bg px-2 py-0.5 text-[11px] font-medium text-error-bright">
          Bypass
        </span>
      )}
      {showWsStatus && (
        <span className="size-1.5 shrink-0 rounded-full bg-success" title="Connected" />
      )}
    </div>
  );
}
