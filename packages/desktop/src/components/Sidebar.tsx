import { useState, useEffect } from "react";
import { create } from "zustand";
import { useNavigate, useMatches } from "@tanstack/react-router";
import { useAuthStore } from "../stores/auth";
import { useWorkspacesStore } from "../stores/workspaces";
import { useConversationsStore } from "../stores/conversations";
import { useStreamingConvIds } from "../stores/streaming";
import { useNotificationsStore } from "../stores/notifications";
import { openAuthModal } from "./AuthModal";
import { openCodexAuthModal } from "./CodexAuthModal";
import { openWorkspaceModal } from "./WorkspaceModal";
import { useCodexAuthStore } from "../stores/codex-auth";
import { api } from "../lib/api";
import { basename } from "../lib/path";
import type { WorkspaceChannel, WorkspaceMember } from "@thechat/shared";

function ProjectDirLabel({ path }: { path: string }) {
  const [name, setName] = useState<string | null>(null);
  useEffect(() => {
    basename(path).then(setName);
  }, [path]);
  if (!name) return null;
  return <span className="mt-0.5 overflow-hidden text-ellipsis whitespace-nowrap text-[10px] text-text-dimmed">{name}</span>;
}

// Colocated visibility store
export const useSidebarState = create(() => ({
  open: false,
  tab: "workspace" as "workspace" | "agent",
}));
export const toggleSidebar = () =>
  useSidebarState.setState((s) => ({ open: !s.open }));
export const closeSidebar = () => useSidebarState.setState({ open: false });

export function Sidebar() {
  const { open, tab } = useSidebarState();
  const setTab = (t: "workspace" | "agent") =>
    useSidebarState.setState({ tab: t });
  const navigate = useNavigate();
  const matches = useMatches();
  const lastMatch = matches[matches.length - 1];
  const routePath = lastMatch?.fullPath ?? "";
  const routeParams = (lastMatch?.params ?? {}) as Record<string, string>;

  // Store data
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const token = useAuthStore((s) => s.token);
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const activeWorkspace = useWorkspacesStore((s) => s.activeWorkspace);
  const selectWorkspace = useWorkspacesStore((s) => s.selectWorkspace);
  const conversations = useConversationsStore((s) => s.conversations);
  const unreadAgentChats = useConversationsStore((s) => s.unreadAgentChats);
  const unreadChannels = useConversationsStore((s) => s.unreadChannels);
  const streamingConvIds = useStreamingConvIds();
  const notificationCount = useNotificationsStore((s) => s.notifications.length);
  const codexStatus = useCodexAuthStore((s) => s.status);

  // Determine current active IDs from route
  const isAgentChat = routePath.startsWith("/chat");
  const isChannel = routePath.startsWith("/channel");
  const isDm = routePath.startsWith("/dm");
  const currentAgentChatId = isAgentChat ? routeParams.id : undefined;
  const activeChannelId = isChannel ? routeParams.id : null;
  const activeDmUserId = isDm ? routeParams.id : null;

  // Local UI state
  const [dropdownOpen, setDropdownOpen] = useState(false);

  const handleNewChat = () => {
    navigate({ to: "/chat" });
    closeSidebar();
  };

  const handleSelectConversation = (conv: { id: string }) => {
    navigate({ to: "/chat/$id", params: { id: conv.id } });
    useConversationsStore.getState().markAgentChatRead(conv.id);
    closeSidebar();
  };

  const handleSelectChannel = (channel: WorkspaceChannel) => {
    navigate({ to: "/channel/$id", params: { id: channel.id } });
    useConversationsStore.getState().markChannelRead(channel.id);
    closeSidebar();
  };

  const handleSelectDm = async (member: WorkspaceMember) => {
    if (!token || !activeWorkspace) return;
    try {
      const { data, error } = await api.conversations.dm.post(
        { workspaceId: activeWorkspace.id, otherUserId: member.userId },
        { headers: { authorization: `Bearer ${token}` } },
      );
      if (error) throw error;
      if (data && "id" in data) {
        navigate({ to: "/dm/$id", params: { id: data.id! } });
        closeSidebar();
      }
    } catch {
      // Failed to create/get DM
    }
  };

  return (
    <>
      {open && <div className="fixed inset-0 z-[9] bg-overlay" onClick={closeSidebar} />}
      <div className={`absolute top-0 bottom-0 z-10 flex w-[260px] shrink-0 flex-col border-r border-border bg-surface transition-[margin-left] duration-200 ${open ? "ml-0" : "-ml-[260px]"}`}>
        {/* Workspace switcher (only when logged in) */}
        {user && (
          <div className="relative border-b border-border p-2">
            <button
              className="flex w-full cursor-pointer items-center justify-between rounded-lg border border-border-strong bg-elevated px-3 py-2 font-[inherit] text-sm font-medium text-text hover:bg-border-strong"
              onClick={() => setDropdownOpen(!dropdownOpen)}
            >
              <span>
                {activeWorkspace ? activeWorkspace.name : "Select workspace"}
              </span>
              <span className="text-[10px] text-text-muted">
                {dropdownOpen ? "\u25B2" : "\u25BC"}
              </span>
            </button>
            {dropdownOpen && (
              <div className="absolute top-full right-2 left-2 z-[15] mt-1 overflow-hidden rounded-lg border border-border-strong bg-surface shadow-card">
                {workspaces.map((ws) => (
                  <button
                    key={ws.id}
                    className={`block w-full cursor-pointer border-none px-3 py-2 text-left font-[inherit] text-[13px] ${
                      activeWorkspace?.id === ws.id
                        ? "bg-elevated text-text"
                        : "bg-none text-text-muted hover:bg-hover hover:text-text"
                    }`}
                    onClick={() => {
                      selectWorkspace(ws.id);
                      setDropdownOpen(false);
                    }}
                  >
                    {ws.name}
                  </button>
                ))}
                <button
                  className="block w-full cursor-pointer border-t border-border bg-none px-3 py-2 text-left font-[inherit] text-[13px] text-accent hover:bg-hover hover:text-text"
                  onClick={() => {
                    openWorkspaceModal();
                    setDropdownOpen(false);
                  }}
                >
                  + Create workspace
                </button>
              </div>
            )}
          </div>
        )}

        {/* Tab toggle (only when workspace is active) */}
        {user && activeWorkspace && (
          <div className="flex gap-1 border-b border-border px-2 py-1.5">
            <button
              className={`flex flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-md border-none px-2 py-1.5 font-[inherit] text-xs font-medium ${tab === "workspace" ? "bg-elevated text-text" : "bg-none text-text-muted hover:bg-hover hover:text-text"}`}
              onClick={() => setTab("workspace")}
            >
              Workspace
              {unreadChannels.size > 0 && tab !== "workspace" && (
                <span className="size-1.5 shrink-0 rounded-full bg-accent" />
              )}
            </button>
            <button
              className={`flex flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-md border-none px-2 py-1.5 font-[inherit] text-xs font-medium ${tab === "agent" ? "bg-elevated text-text" : "bg-none text-text-muted hover:bg-hover hover:text-text"}`}
              onClick={() => setTab("agent")}
            >
              Agent Chats
              {unreadAgentChats.size > 0 && tab !== "agent" && (
                <span className="size-1.5 shrink-0 rounded-full bg-accent" />
              )}
            </button>
          </div>
        )}

        {/* Workspace tab content */}
        {user && activeWorkspace && tab === "workspace" && (
          <>
            {/* Notifications button */}
            <button
              className="flex w-full cursor-pointer items-center justify-between border-b border-border-subtle bg-none px-3 py-2 text-[0.85rem] text-text-secondary hover:bg-hover hover:text-text"
              style={{ border: "none", borderBottom: "1px solid var(--color-border-subtle)" }}
              onClick={() => {
                navigate({ to: "/notifications" });
                closeSidebar();
              }}
            >
              <span>Notifications</span>
              {notificationCount > 0 && (
                <span className="min-w-[18px] rounded-[9px] bg-accent px-1.5 py-px text-center text-[0.7rem] font-semibold text-white">
                  {notificationCount}
                </span>
              )}
            </button>

            <div className="px-2">
              <div className="px-3 pt-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-text-dimmed">Channels</div>
              <div className="pb-1">
                {activeWorkspace.channels.map((ch) => {
                  const isActive = activeChannelId === ch.id;
                  const isUnread = unreadChannels.has(ch.id);
                  return (
                    <button
                      key={ch.id}
                      className={`mb-px block w-full cursor-pointer rounded-md border-none px-3 py-1.5 text-left font-[inherit] text-[13px] ${isActive ? "bg-elevated text-text" : "bg-none text-text-muted hover:bg-hover hover:text-text"} ${isUnread ? "relative font-semibold text-text" : ""}`}
                      onClick={() => handleSelectChannel(ch)}
                    >
                      <span className="mr-0.5 text-text-dimmed">#</span> {ch.name}
                      {isUnread && <span className="ml-auto inline-block size-1.5 shrink-0 rounded-full bg-accent" />}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="px-2">
              <div className="px-3 pt-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-text-dimmed">Direct Messages</div>
              <div className="pb-1">
                {activeWorkspace.members
                  .filter((m) => m.userId !== user.id)
                  .map((m) => {
                    const isActive = activeDmUserId === m.userId;
                    return (
                      <button
                        key={m.userId}
                        className={`mb-px flex w-full cursor-pointer items-center gap-2 rounded-md border-none px-3 py-1.5 text-left font-[inherit] text-[13px] ${isActive ? "bg-elevated text-text" : "bg-none text-text-muted hover:bg-hover hover:text-text"}`}
                        onClick={() => handleSelectDm(m)}
                      >
                        <span className="flex size-6 shrink-0 items-center justify-center rounded-full border border-border bg-elevated text-[11px] font-semibold text-text-muted">
                          {m.user.name.charAt(0).toUpperCase()}
                        </span>
                        <span className="overflow-hidden text-ellipsis whitespace-nowrap">{m.user.name}</span>
                      </button>
                    );
                  })}
              </div>
            </div>
          </>
        )}

        {/* Agent Chats tab content (or full view when no workspace) */}
        {(tab === "agent" || !activeWorkspace || !user) && (
          <div className="flex min-h-0 flex-1 flex-col">
            <button className="m-1 cursor-pointer rounded-lg border border-border-strong bg-elevated p-2.5 text-sm text-text hover:bg-border-strong" onClick={handleNewChat}>
              + New Chat
            </button>
            <div className="flex-1 overflow-y-auto px-2">
              {conversations.map((conv) => {
                const isActive = currentAgentChatId === conv.id;
                const isUnread = !isActive && unreadAgentChats.has(conv.id);
                const isStreamingBg = !isActive && streamingConvIds.has(conv.id);
                return (
                  <button
                    key={conv.id}
                    className={`mb-0.5 flex w-full cursor-pointer items-center gap-1.5 rounded-md border-none bg-none px-3 py-2.5 text-left text-[13px] ${isActive ? "bg-elevated text-text" : "text-text-muted hover:bg-hover"} ${isUnread ? "font-semibold text-text" : ""}`}
                    onClick={() => handleSelectConversation(conv)}
                  >
                    <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">{conv.title}</span>
                    {conv.project_dir && (
                      <ProjectDirLabel path={conv.project_dir} />
                    )}
                    {isStreamingBg && <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-accent" />}
                    {!isStreamingBg && isUnread && <span className="size-1.5 shrink-0 rounded-full bg-accent" />}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <div className="border-t border-border p-3">
          <button
            className="mb-2 flex w-full cursor-pointer items-center gap-2 rounded-lg border border-border bg-none px-2 py-2 font-[inherit] text-[13px] text-text-muted hover:bg-hover hover:text-text"
            onClick={openCodexAuthModal}
          >
            {codexStatus === "authenticated" ? (
              <>
                <span className="size-2 shrink-0 rounded-full bg-green-500" />
                <span>ChatGPT Connected</span>
              </>
            ) : (
              <span>Connect ChatGPT Pro/Plus</span>
            )}
          </button>
          {user ? (
            <div className="flex items-center justify-between gap-2">
              <span className="overflow-hidden text-ellipsis whitespace-nowrap text-[13px] text-text">{user.name}</span>
              <button className="shrink-0 cursor-pointer rounded border-none bg-none px-2 py-1 font-[inherit] text-xs text-text-muted hover:bg-hover hover:text-text" onClick={logout}>
                Log out
              </button>
            </div>
          ) : (
            <button className="block w-full cursor-pointer rounded-lg border border-border bg-none px-2 py-2 font-[inherit] text-[13px] text-text-muted hover:bg-hover hover:text-text" onClick={openAuthModal}>
              Log in
            </button>
          )}
        </div>
      </div>
    </>
  );
}
