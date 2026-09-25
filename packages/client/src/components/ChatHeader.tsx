import { MOBILE_NAV_QUERY, NavigationToggle, useMediaQuery } from "./ResponsiveShell";
import { create } from "zustand";
import { useMatches } from "@tanstack/react-router";
import { useWorkspacesStore } from "../stores/workspaces";
import { usePermissionModeStore } from "../stores/permission-mode";
import { useAuthStore } from "../stores/auth";
import { useDmHeaderStore } from "../stores/chat-header";
import { isWeb } from "../platform/environment";
import { toggleSidebar, useSidebarState } from "./Sidebar";
import { HeaderActionsSlot } from "./HeaderActions";
import { PanelLeft } from "lucide-react";
import { iconButtonClass } from "./ui";

// Mini-store for agent chat title & project dir (set by agent-chat route)
const useAgentChatTitle = create(() => ({ title: "", projectDir: null as string | null }));
export const setAgentChatTitle = (title: string) =>
  useAgentChatTitle.setState({ title });
export const setAgentChatProjectDir = (projectDir: string | null) =>
  useAgentChatTitle.setState({ projectDir });
export const getAgentChatProjectDir = () => useAgentChatTitle.getState().projectDir;

const pageLabels: Record<string, string> = {
  "/settings": "Settings",
  "/workspace/manage": "Workspace settings",
  "/bots/manage": "Bots",
  "/notifications": "Notifications",
  "/activity": "Activity",
};

export function ChatHeader() {
  const activeWorkspace = useWorkspacesStore((s) => s.activeWorkspace);
  const permissionMode = usePermissionModeStore((s) => s.mode);
  const userId = useAuthStore((s) => s.user?.id ?? null);
  const token = useAuthStore((s) => s.token);
  const dmIdentity = useDmHeaderStore((s) => s.identity);
  const agentTitle = useAgentChatTitle((s) => s.title);
  const mobile = useMediaQuery(MOBILE_NAV_QUERY);
  const sidebarOpen = useSidebarState((s) => s.open);
  const matches = useMatches();
  const lastMatch = matches[matches.length - 1];
  const routePath = lastMatch?.fullPath ?? "";
  const params = (lastMatch?.params ?? {}) as Record<string, string>;
  const isChannel = routePath.startsWith("/channel/");
  const isDm = routePath.startsWith("/dm/");
  const isAgentChat = routePath === "/chat" || routePath.startsWith("/chat/");
  const isPage = routePath === "/" || routePath in pageLabels;
  // The web shell has no window titlebar: never hide its only sidebar escape.
  const showSidebarToggle = isWeb && !mobile && !sidebarOpen;
  const currentDm = isDm && dmIdentity?.conversationId === params.id &&
    dmIdentity.userId === userId && dmIdentity.token === token ? dmIdentity : null;
  const channel = isChannel
    ? activeWorkspace?.channels.find((item) => item.id === params.id)
    : null;
  const title = isChannel ? channel?.name ?? ""
    : isDm ? currentDm?.title ?? ""
      : isAgentChat ? agentTitle
        : pageLabels[routePath] ?? activeWorkspace?.name ?? "Home";
  const context = currentDm?.context;

  if (isPage && !mobile && !showSidebarToggle) return null;

  return (
    <header className="chat-header flex h-[48px] min-w-0 shrink-0 items-center gap-2 border-b border-border-subtle bg-base pl-5 pr-3" aria-label={isPage ? "Page navigation" : "Conversation header"}>
      <NavigationToggle />
      {showSidebarToggle && (
        <button type="button" className={iconButtonClass("md")} aria-label="Open sidebar" title="Open sidebar" onClick={toggleSidebar}>
          <PanelLeft size={16} aria-hidden="true" />
        </button>
      )}
      <div className="flex min-w-0 flex-1 items-center">
        {isChannel && <span className="mr-2 shrink-0 text-[1rem] text-text-dimmed" aria-hidden="true">#</span>}
        <span title={title} className={`min-w-0 truncate ${isPage ? "text-[0.929rem] text-text-muted" : "text-[1rem] font-semibold text-text"} ${context ? "max-w-[60%] shrink-0" : ""}`}>{title}</span>
        {context && <>
          <span className="mx-1.5 shrink-0 text-text-dimmed" aria-hidden="true">·</span>
          <span title={context} className="min-w-0 truncate text-[0.857rem] text-text-muted">{context}</span>
        </>}
      </div>
      {isAgentChat && permissionMode === "allow-edits" && (
        <span className="shrink-0 whitespace-nowrap rounded-md bg-warning-bg px-2 py-0.5 text-[0.786rem] font-medium text-warning-text">
          Allow Edits
        </span>
      )}
      {isAgentChat && permissionMode === "bypass" && (
        <span className="shrink-0 whitespace-nowrap rounded-md bg-danger-bg px-2 py-0.5 text-[0.786rem] font-medium text-error-bright">
          Bypass
        </span>
      )}
      <HeaderActionsSlot />
    </header>
  );
}
