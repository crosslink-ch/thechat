import { create } from "zustand";
import { useMatches } from "@tanstack/react-router";
import { useWorkspacesStore } from "../stores/workspaces";
import { usePermissionModeStore } from "../stores/permission-mode";

// Mini-store for agent chat title & project dir (set by agent-chat route)
const useAgentChatTitle = create(() => ({ title: "", projectDir: null as string | null }));
export const setAgentChatTitle = (title: string) =>
  useAgentChatTitle.setState({ title });
export const setAgentChatProjectDir = (projectDir: string | null) =>
  useAgentChatTitle.setState({ projectDir });
export const getAgentChatProjectDir = () => useAgentChatTitle.getState().projectDir;

export function ChatHeader() {
  const activeWorkspace = useWorkspacesStore((s) => s.activeWorkspace);
  const permissionMode = usePermissionModeStore((s) => s.mode);
  const matches = useMatches();
  const lastMatch = matches[matches.length - 1];
  const routePath = lastMatch?.fullPath ?? "";
  const params = (lastMatch?.params ?? {}) as Record<string, string>;

  const isChannel = routePath.startsWith("/channel");
  const isDm = routePath.startsWith("/dm");
  const isSettings = routePath === "/settings";
  const isWorkspaceHome = routePath === "/";
  const isWorkspaceManage = routePath === "/workspace/manage";
  const isNotifications = routePath === "/notifications";

  let chatTitle = "Workspace";
  if (isSettings) {
    chatTitle = "Settings";
  } else if (isWorkspaceManage) {
    chatTitle = activeWorkspace?.name ?? "Workspace";
  } else if (isNotifications) {
    chatTitle = "Notifications";
  } else if (isChannel) {
    const channelId = params.id;
    const channel = activeWorkspace?.channels.find((ch) => ch.id === channelId);
    chatTitle = channel ? `# ${channel.name}` : "# Channel";
  } else if (isDm) {
    chatTitle = "Direct Message";
  }

  const showBackButton = !isWorkspaceHome;

  return (
    <div className="flex h-12 shrink-0 items-center gap-1.5 border-b border-border-subtle bg-surface px-3">
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
      <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[0.929rem] text-text-muted">{chatTitle}</span>
      {permissionMode === "allow-edits" && (
        <span className="rounded-md bg-warning-bg px-2 py-0.5 text-[0.786rem] font-medium text-warning-text">
          Allow Edits
        </span>
      )}
      {permissionMode === "bypass" && (
        <span className="rounded-md bg-danger-bg px-2 py-0.5 text-[0.786rem] font-medium text-error-bright">
          Bypass
        </span>
      )}
    </div>
  );
}
