import { useState, useEffect, useRef } from "react";
import { create } from "zustand";
import { useNavigate, useMatches } from "@tanstack/react-router";
import { useAuthStore } from "../stores/auth";
import { useWorkspacesStore } from "../stores/workspaces";
import { useConversationsStore } from "../stores/conversations";
import { useStreamingConvIds } from "../stores/streaming";
import { useNotificationsStore } from "../stores/notifications";
import { openAuthModal } from "./AuthModal";
import { openCodexAuthModal } from "./CodexAuthModal";
import { openAnthropicAuthModal } from "./AnthropicAuthModal";
import { openWorkspaceModal } from "./WorkspaceModal";
import { useCodexAuthStore } from "../stores/codex-auth";
import { useAnthropicAuthStore } from "../stores/anthropic-auth";
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
  open: true,
  tab: "agent" as "workspace" | "agent",
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
  const anthropicStatus = useAnthropicAuthStore((s) => s.status);

  // Determine current active IDs from route
  const isAgentChat = routePath.startsWith("/chat");
  const isChannel = routePath.startsWith("/channel");
  const isDm = routePath.startsWith("/dm");
  const isSettings = routePath === "/settings";
  const currentAgentChatId = isAgentChat ? routeParams.id : undefined;
  const activeChannelId = isChannel ? routeParams.id : null;
  const activeDmUserId = isDm ? routeParams.id : null;

  // Local UI state
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const profileMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!profileMenuOpen) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (!profileMenuRef.current) return;
      if (!profileMenuRef.current.contains(event.target as Node)) {
        setProfileMenuOpen(false);
      }
    };

    window.addEventListener("mousedown", handleClickOutside);
    return () => window.removeEventListener("mousedown", handleClickOutside);
  }, [profileMenuOpen]);

  const initials = user?.name?.trim().charAt(0).toUpperCase() ?? "?";

  const handleNewChat = () => {
    navigate({ to: "/chat" });
  };

  const handleSelectConversation = (conv: { id: string }) => {
    navigate({ to: "/chat/$id", params: { id: conv.id } });
    useConversationsStore.getState().markAgentChatRead(conv.id);
  };

  const handleSelectChannel = (channel: WorkspaceChannel) => {
    navigate({ to: "/channel/$id", params: { id: channel.id } });
    useConversationsStore.getState().markChannelRead(channel.id);
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
      }
    } catch {
      // Failed to create/get DM
    }
  };

  return (
      <div className={`flex h-full w-[260px] shrink-0 flex-col border-r border-border bg-surface transition-[margin-left] duration-200 ease-out ${open ? "ml-0" : "-ml-[260px]"}`}>
        <div className="border-b border-border-subtle p-2">
          <div className="mb-2 flex items-center gap-1.5">
            <button
              aria-label="Collapse sidebar"
              className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md border border-border bg-raised text-text-muted transition-colors duration-150 hover:bg-hover hover:text-text"
              onClick={toggleSidebar}
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 2.5H11" />
                <path d="M3 7H11" />
                <path d="M3 11.5H11" />
                <path d="M2.5 2.5V11.5" />
              </svg>
            </button>
            <button
              className="flex min-w-0 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-md border border-border bg-raised px-2.5 py-2 font-[inherit] text-[12px] font-medium text-text-secondary transition-colors duration-150 hover:bg-hover hover:text-text"
              onClick={handleNewChat}
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                <path d="M6 2.5V9.5" />
                <path d="M2.5 6H9.5" />
              </svg>
              <span>New Chat</span>
            </button>
          </div>

          {user && (
            <div className="relative">
              <button
                className="flex w-full cursor-pointer items-center justify-between rounded-md border border-border bg-raised px-2.5 py-2 font-[inherit] text-[12px] font-medium text-text transition-colors duration-150 hover:bg-hover"
                onClick={() => setDropdownOpen(!dropdownOpen)}
              >
                <span className="overflow-hidden text-ellipsis whitespace-nowrap">
                  {activeWorkspace ? activeWorkspace.name : "Select workspace"}
                </span>
                <svg className={`shrink-0 text-text-dimmed transition-transform duration-150 ${dropdownOpen ? "rotate-180" : ""}`} width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 4.5L6 7.5L9 4.5" />
                </svg>
              </button>
              {dropdownOpen && (
                <div className="absolute top-full right-0 left-0 z-[15] mt-1 overflow-hidden rounded-md border border-border-strong bg-surface shadow-card animate-fade-in">
                  {workspaces.map((ws) => (
                    <button
                      key={ws.id}
                      className={`block w-full cursor-pointer border-none px-2.5 py-2 text-left font-[inherit] text-[12px] transition-colors duration-100 ${
                        activeWorkspace?.id === ws.id
                          ? "bg-elevated text-text"
                          : "bg-none text-text-muted hover:bg-hover hover:text-text"
                      }`}
                      onClick={() => {
                        selectWorkspace(ws.id);
                        setDropdownOpen(false);
                        setProfileMenuOpen(false);
                      }}
                    >
                      {ws.name}
                    </button>
                  ))}
                  <button
                    className="block w-full cursor-pointer border-t border-border bg-none px-2.5 py-2 text-left font-[inherit] text-[12px] text-accent transition-colors duration-100 hover:bg-hover hover:text-text"
                    onClick={() => {
                      openWorkspaceModal();
                      setDropdownOpen(false);
                      setProfileMenuOpen(false);
                    }}
                  >
                    + Create workspace
                  </button>
                </div>
              )}
            </div>
          )}

          {user && activeWorkspace && (
            <div className="mt-2 flex gap-1 rounded-lg bg-raised p-1">
              <button
                className={`flex flex-1 cursor-pointer items-center justify-center gap-1 rounded-md border-none px-2 py-1.5 font-[inherit] text-[11px] font-semibold transition-colors duration-150 ${tab === "agent" ? "bg-elevated text-text" : "bg-none text-text-muted hover:bg-hover hover:text-text"}`}
                onClick={() => setTab("agent")}
              >
                Agent Chats
                {unreadAgentChats.size > 0 && tab !== "agent" && (
                  <span className="size-1.5 shrink-0 rounded-full bg-accent" />
                )}
              </button>
              <button
                className={`flex flex-1 cursor-pointer items-center justify-center gap-1 rounded-md border-none px-2 py-1.5 font-[inherit] text-[11px] font-semibold transition-colors duration-150 ${tab === "workspace" ? "bg-elevated text-text" : "bg-none text-text-muted hover:bg-hover hover:text-text"}`}
                onClick={() => setTab("workspace")}
              >
                Workspace
                {unreadChannels.size > 0 && tab !== "workspace" && (
                  <span className="size-1.5 shrink-0 rounded-full bg-accent" />
                )}
              </button>
            </div>
          )}
        </div>

        {/* Workspace tab content */}
        {user && activeWorkspace && tab === "workspace" && (
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
            {/* Channels */}
            <div className="mt-1 px-2.5">
              <div className="px-2.5 pt-3 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-text-dimmed">Channels</div>
              <div className="pb-1">
                {activeWorkspace.channels.map((ch) => {
                  const isActive = activeChannelId === ch.id;
                  const isUnread = unreadChannels.has(ch.id);
                  return (
                    <button
                      key={ch.id}
                      className={`mb-px flex w-full cursor-pointer items-center gap-1.5 rounded-md border-none px-2.5 py-1.5 text-left font-[inherit] text-[13px] transition-colors duration-100 ${isActive ? "bg-elevated text-text" : "bg-none text-text-muted hover:bg-hover hover:text-text"} ${isUnread ? "font-semibold text-text" : ""}`}
                      onClick={() => handleSelectChannel(ch)}
                    >
                      <span className="text-text-dimmed">#</span>
                      <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">{ch.name}</span>
                      {isUnread && <span className="size-1.5 shrink-0 rounded-full bg-accent" />}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Direct Messages */}
            {(() => {
              const others = activeWorkspace.members.filter((m) => m.userId !== user.id);
              const humans = others.filter((m) => m.user.type !== "bot");
              const bots = others.filter((m) => m.user.type === "bot");

              const renderMember = (m: WorkspaceMember) => {
                const isActive = activeDmUserId === m.userId;
                return (
                  <button
                    key={m.userId}
                    className={`mb-px flex w-full cursor-pointer items-center gap-2 rounded-md border-none px-2.5 py-1.5 text-left font-[inherit] text-[13px] transition-colors duration-100 ${isActive ? "bg-elevated text-text" : "bg-none text-text-muted hover:bg-hover hover:text-text"}`}
                    onClick={() => handleSelectDm(m)}
                  >
                    <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-elevated text-[10px] font-semibold text-text-muted">
                      {m.user.name.charAt(0).toUpperCase()}
                    </span>
                    <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">{m.user.name}</span>
                  </button>
                );
              };

              return (
                <div className="px-2.5">
                  {humans.length > 0 && (
                    <>
                      <div className="px-2.5 pt-3 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-text-dimmed">People</div>
                      <div className="pb-1">{humans.map(renderMember)}</div>
                    </>
                  )}
                  {bots.length > 0 && (
                    <>
                      <div className="px-2.5 pt-3 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-text-dimmed">Bots</div>
                      <div className="pb-1">{bots.map(renderMember)}</div>
                    </>
                  )}
                </div>
              );
            })()}
          </div>
        )}

        {/* Agent Chats tab content (or full view when no workspace) */}
        {(tab === "agent" || !activeWorkspace || !user) && (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex-1 overflow-y-auto px-2.5 pt-2">
              {conversations.map((conv) => {
                const isActive = currentAgentChatId === conv.id;
                const isUnread = !isActive && unreadAgentChats.has(conv.id);
                const isStreamingBg = !isActive && streamingConvIds.has(conv.id);
                return (
                  <button
                    key={conv.id}
                    className={`mb-0.5 flex w-full cursor-pointer items-center gap-1.5 rounded-md border-none bg-none px-2.5 py-2 text-left font-[inherit] text-[13px] transition-colors duration-100 ${isActive ? "bg-elevated text-text" : "text-text-muted hover:bg-hover hover:text-text"} ${isUnread ? "font-semibold text-text" : ""}`}
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

        {/* Footer */}
        <div className="border-t border-border-subtle px-2.5 py-2">
          {user ? (
            <div className="relative" ref={profileMenuRef}>
              <button
                className="flex w-full cursor-pointer items-center justify-between gap-2 rounded-lg border border-border bg-raised px-2.5 py-2 text-left font-[inherit] transition-colors duration-150 hover:bg-hover"
                onClick={() => setProfileMenuOpen((v) => !v)}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-elevated text-[12px] font-semibold text-text">
                    {initials}
                  </span>
                  <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[12px] font-medium text-text-secondary">
                    {user.name}
                  </span>
                </span>
                <svg className={`shrink-0 text-text-dimmed transition-transform duration-150 ${profileMenuOpen ? "rotate-180" : ""}`} width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 4.5L6 7.5L9 4.5" />
                </svg>
              </button>

              <button
                className="mt-1.5 flex w-full cursor-pointer items-center justify-between rounded-md border-none bg-none px-2.5 py-2 text-[12px] text-text-secondary transition-colors duration-150 hover:bg-hover hover:text-text"
                onClick={() => navigate({ to: "/notifications" })}
              >
                <span className="flex items-center gap-2">
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M10.5 4.67a3.5 3.5 0 1 0-7 0c0 4.08-1.75 5.25-1.75 5.25h10.5s-1.75-1.17-1.75-5.25" />
                    <path d="M8.01 11.67a1.17 1.17 0 0 1-2.02 0" />
                  </svg>
                  Notifications
                </span>
                {notificationCount > 0 && (
                  <span className="min-w-[18px] rounded-full bg-accent px-1.5 py-px text-center text-[10px] font-semibold text-white">
                    {notificationCount}
                  </span>
                )}
              </button>

              {profileMenuOpen && (
                <div className="absolute right-0 bottom-[calc(100%+6px)] z-20 min-w-[220px] overflow-hidden rounded-lg border border-border-strong bg-surface shadow-card animate-fade-in">
                  <button
                    className="flex w-full cursor-pointer items-center justify-between gap-2 border-none bg-none px-3 py-2.5 text-left font-[inherit] text-[12px] text-text-secondary transition-colors duration-100 hover:bg-hover hover:text-text"
                    onClick={() => {
                      openCodexAuthModal();
                      setProfileMenuOpen(false);
                    }}
                  >
                    <span>ChatGPT</span>
                    <span className={`text-[11px] ${codexStatus === "authenticated" ? "text-success" : "text-text-dimmed"}`}>
                      {codexStatus === "authenticated" ? "Connected" : "Not connected"}
                    </span>
                  </button>
                  <button
                    className="flex w-full cursor-pointer items-center justify-between gap-2 border-none bg-none px-3 py-2.5 text-left font-[inherit] text-[12px] text-text-secondary transition-colors duration-100 hover:bg-hover hover:text-text"
                    onClick={() => {
                      openAnthropicAuthModal();
                      setProfileMenuOpen(false);
                    }}
                  >
                    <span>Claude</span>
                    <span className={`text-[11px] ${anthropicStatus === "authenticated" ? "text-success" : "text-text-dimmed"}`}>
                      {anthropicStatus === "authenticated" ? "Connected" : "Not connected"}
                    </span>
                  </button>
                  <button
                    className="flex w-full cursor-pointer items-center justify-between gap-2 border-none bg-none px-3 py-2.5 text-left font-[inherit] text-[12px] text-text-secondary transition-colors duration-100 hover:bg-hover hover:text-text"
                    onClick={() => {
                      navigate({ to: "/notifications" });
                      setProfileMenuOpen(false);
                    }}
                  >
                    <span>Notifications</span>
                    {notificationCount > 0 && (
                      <span className="min-w-[18px] rounded-full bg-accent px-1.5 py-px text-center text-[10px] font-semibold text-white">
                        {notificationCount}
                      </span>
                    )}
                  </button>
                  <button
                    className="block w-full cursor-pointer border-none bg-none px-3 py-2.5 text-left font-[inherit] text-[12px] text-text-secondary transition-colors duration-100 hover:bg-hover hover:text-text"
                    onClick={() => {
                      navigate({ to: "/settings" });
                      setProfileMenuOpen(false);
                    }}
                  >
                    Settings
                  </button>
                  <button
                    className="block w-full cursor-pointer border-t border-border bg-none px-3 py-2.5 text-left font-[inherit] text-[12px] text-text-dimmed transition-colors duration-100 hover:bg-hover hover:text-text"
                    onClick={() => {
                      logout();
                      setProfileMenuOpen(false);
                    }}
                  >
                    Log out
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-1">
              <button
                className={`flex w-full cursor-pointer items-center gap-2 rounded-md border-none px-2.5 py-2 text-left font-[inherit] text-[12px] transition-colors duration-150 ${isSettings ? "bg-elevated text-text" : "bg-none text-text-secondary hover:bg-hover hover:text-text"}`}
                onClick={() => navigate({ to: "/settings" })}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="3" />
                  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33h-.09a1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09a1.65 1.65 0 0 0-1-1.51h-.09a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82v-.09a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09a1.65 1.65 0 0 0 1.51-1v-.09a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33h.09a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51h.09a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.09a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
                </svg>
                Settings
              </button>
              <button
                className="flex w-full cursor-pointer items-center justify-between rounded-md border-none bg-none px-2.5 py-2 text-left font-[inherit] text-[12px] text-text-secondary transition-colors duration-150 hover:bg-hover hover:text-text"
                onClick={openCodexAuthModal}
              >
                <span className="flex items-center gap-2">
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M7 1.17 8.46 4.7l3.87.34-2.95 2.54.88 3.8L7 9.42l-3.26 1.96.88-3.8-2.95-2.54 3.87-.34Z" />
                  </svg>
                  ChatGPT
                </span>
                <span className={`text-[11px] ${codexStatus === "authenticated" ? "text-success" : "text-text-dimmed"}`}>
                  {codexStatus === "authenticated" ? "Connected" : "Not connected"}
                </span>
              </button>
              <button
                className="flex w-full cursor-pointer items-center justify-between rounded-md border-none bg-none px-2.5 py-2 text-left font-[inherit] text-[12px] text-text-secondary transition-colors duration-150 hover:bg-hover hover:text-text"
                onClick={openAnthropicAuthModal}
              >
                <span className="flex items-center gap-2">
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M7 1.17 8.46 4.7l3.87.34-2.95 2.54.88 3.8L7 9.42l-3.26 1.96.88-3.8-2.95-2.54 3.87-.34Z" />
                  </svg>
                  Claude
                </span>
                <span className={`text-[11px] ${anthropicStatus === "authenticated" ? "text-success" : "text-text-dimmed"}`}>
                  {anthropicStatus === "authenticated" ? "Connected" : "Not connected"}
                </span>
              </button>
              <button
                className="mt-1 flex w-full cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-border bg-raised px-2.5 py-2 font-[inherit] text-[12px] font-medium text-text-secondary transition-colors duration-150 hover:bg-hover hover:text-text"
                onClick={openAuthModal}
              >
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M7.5 10.5v-1a2 2 0 0 0-2-2h-3a2 2 0 0 0-2 2v1" />
                  <circle cx="4" cy="4" r="2" />
                  <path d="M10 3.5v3M8.5 5h3" />
                </svg>
                Log in
              </button>
            </div>
          )}
        </div>
      </div>
  );
}
