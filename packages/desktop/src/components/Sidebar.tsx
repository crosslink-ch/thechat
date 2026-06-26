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
import { openWorkspaceModal } from "./WorkspaceModal";
import { useCodexAuthStore } from "../stores/codex-auth";
import { api } from "../lib/api";
import { basename } from "../lib/path";
import type { WorkspaceChannel, WorkspaceMember } from "@thechat/shared";

const SIDEBAR_WIDTH = 347;

function ProjectDirLabel({ path }: { path: string }) {
  const [name, setName] = useState<string | null>(null);
  useEffect(() => {
    basename(path).then(setName);
  }, [path]);
  if (!name) return null;
  return <span className="mt-0.5 overflow-hidden text-ellipsis whitespace-nowrap text-[0.714rem] text-text-dimmed">{name}</span>;
}

function PlusIcon({ className = "" }: { className?: string }) {
  return (
    <svg className={className} width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
      <path d="M7 3v8" />
      <path d="M3 7h8" />
    </svg>
  );
}

function SearchIcon({ className = "" }: { className?: string }) {
  return (
    <svg className={className} width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <circle cx="6.2" cy="6.2" r="3.7" />
      <path d="m9.1 9.1 2.4 2.4" />
    </svg>
  );
}

function ChevronDownIcon({ open = false }: { open?: boolean }) {
  return (
    <svg className={`shrink-0 text-text-dimmed transition-transform duration-150 ${open ? "rotate-180" : ""}`} width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3.5 5.25 7 8.75l3.5-3.5" />
    </svg>
  );
}

function BellIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M13.5 6.25a4.5 4.5 0 0 0-9 0c0 5.25-2.25 6.75-2.25 6.75h13.5s-2.25-1.5-2.25-6.75" />
      <path d="M10.3 15a1.5 1.5 0 0 1-2.6 0" />
    </svg>
  );
}

function MessageIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12.5 9.5a1.5 1.5 0 0 1-1.5 1.5H6l-3.5 2v-10A1.5 1.5 0 0 1 4 1.5h7A1.5 1.5 0 0 1 12.5 3z" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="7.5" cy="7.5" r="2" />
      <path d="M12.4 8.6a1.3 1.3 0 0 0 .25 1.43l.04.04a1.55 1.55 0 0 1-2.2 2.2l-.04-.04A1.3 1.3 0 0 0 9 12a1.3 1.3 0 0 0-.8 1.2v.1a1.55 1.55 0 0 1-3.1 0v-.06A1.3 1.3 0 0 0 4.25 12a1.3 1.3 0 0 0-1.43.25l-.04.04a1.55 1.55 0 0 1-2.2-2.2l.04-.04A1.3 1.3 0 0 0 .9 8.6a1.3 1.3 0 0 0-1.2-.8h-.1a1.55 1.55 0 0 1 0-3.1h.06A1.3 1.3 0 0 0 .9 3.9a1.3 1.3 0 0 0-.25-1.43L.61 2.43a1.55 1.55 0 0 1 2.2-2.2l.04.04A1.3 1.3 0 0 0 4.25.5a1.3 1.3 0 0 0 .8-1.2v-.1a1.55 1.55 0 0 1 3.1 0v.06A1.3 1.3 0 0 0 9 .5a1.3 1.3 0 0 0 1.43-.25l.04-.04a1.55 1.55 0 0 1 2.2 2.2l-.04.04a1.3 1.3 0 0 0-.25 1.43c.18.5.67.82 1.2.82h.1a1.55 1.55 0 0 1 0 3.1h-.06c-.53 0-1.02.32-1.2.8Z" />
    </svg>
  );
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

  // Determine current active IDs from route
  const isAgentChat = routePath.startsWith("/chat");
  const isChannel = routePath.startsWith("/channel");
  const isDm = routePath.startsWith("/dm");
  const isSettings = routePath === "/settings";
  const isScrollDebug = routePath === "/debug/scroll";
  const isHermesDebug = routePath === "/debug/hermes";
  const currentAgentChatId = isAgentChat ? routeParams.id : undefined;
  const activeChannelId = isChannel ? routeParams.id : null;
  const activeDmUserId = isDm ? routeParams.id : null;

  // Local UI state
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
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
  const workspaceInitial = (activeWorkspace?.name ?? "TheChat").trim().charAt(0).toUpperCase();
  const normalizedSearch = searchQuery.trim().toLowerCase();
  const filteredConversations = conversations.filter((conv) => {
    if (!normalizedSearch) return true;
    return conv.title.toLowerCase().includes(normalizedSearch);
  });

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

  const renderWorkspaceDropdown = () => (
    <div className="relative">
      <button
        className="flex w-full cursor-pointer items-center justify-between rounded-md border-none bg-transparent px-0 py-0 font-[inherit] text-[1rem] font-semibold text-text transition-colors duration-150 hover:text-text-secondary"
        onClick={() => setDropdownOpen(!dropdownOpen)}
      >
        <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
          {activeWorkspace ? activeWorkspace.name : "Select workspace"}
        </span>
        <ChevronDownIcon open={dropdownOpen} />
      </button>
      {dropdownOpen && (
        <div className="absolute top-full right-0 left-0 z-[15] mt-3 overflow-hidden rounded-md border border-border-strong bg-surface shadow-card animate-fade-in">
          {workspaces.map((ws) => (
            <button
              key={ws.id}
              className={`block w-full cursor-pointer border-none px-3 py-2 text-left font-[inherit] text-[0.9rem] transition-colors duration-100 ${
                activeWorkspace?.id === ws.id
                  ? "bg-elevated text-text"
                  : "bg-transparent text-text-muted hover:bg-hover hover:text-text"
              }`}
              onClick={() => {
                selectWorkspace(ws.id);
                setDropdownOpen(false);
                setProfileMenuOpen(false);
                setTab("workspace");
              }}
            >
              {ws.name}
            </button>
          ))}
          <button
            className="block w-full cursor-pointer border-t border-border bg-transparent px-3 py-2 text-left font-[inherit] text-[0.9rem] text-accent transition-colors duration-100 hover:bg-hover hover:text-text"
            onClick={() => {
              openWorkspaceModal();
              setDropdownOpen(false);
              setProfileMenuOpen(false);
            }}
          >
            Create workspace
          </button>
        </div>
      )}
    </div>
  );

  const renderSectionLabel = (label: string) => (
    <div className="px-1 pt-4 pb-2 text-[0.786rem] font-semibold uppercase tracking-[0.04em] text-text-dimmed">
      {label}
    </div>
  );

  const itemClassName = (active: boolean, unread = false) =>
    [
      "group flex w-full cursor-pointer items-center gap-2 rounded-md border-none px-2 py-1.5 text-left font-[inherit] text-[0.929rem] transition-colors duration-100",
      active
        ? "bg-elevated text-text"
        : "bg-transparent text-text-muted hover:bg-hover hover:text-text",
      unread ? "font-semibold text-text" : "",
    ].join(" ");

  return (
    <div
      className="flex h-full shrink-0 border-r border-border-subtle bg-surface transition-[margin-left] duration-200 ease-out"
      style={{ width: SIDEBAR_WIDTH, marginLeft: open ? 0 : -SIDEBAR_WIDTH }}
    >
      <div className="flex w-[57px] shrink-0 flex-col items-center border-r border-[rgba(245,245,245,0.16)] bg-base py-2">
        <button
          className="relative flex size-9 cursor-pointer items-center justify-center rounded-lg border border-[rgba(245,245,245,0.5)] bg-surface text-[0.9rem] font-bold text-white transition-colors duration-150 hover:bg-hover"
          onClick={() => {
            if (activeWorkspace) setTab("workspace");
          }}
          aria-label="Current workspace"
          title={activeWorkspace?.name ?? "TheChat"}
        >
          <span className="absolute -left-[11px] h-[30px] w-0.5 rounded-r-sm bg-[#2f88bf]" />
          {workspaceInitial}
        </button>

        <button
          className="mt-3 flex size-9 cursor-pointer items-center justify-center rounded-lg border border-dashed border-[rgba(245,245,245,0.5)] bg-surface text-text-dimmed transition-colors duration-150 hover:border-accent hover:text-text"
          onClick={openWorkspaceModal}
          aria-label="Create workspace"
          title="Create workspace"
        >
          <PlusIcon />
        </button>
      </div>

      <div className="flex min-w-0 flex-1 flex-col bg-surface">
        <div className="flex h-[58px] items-center justify-between border-b border-border-subtle px-3">
          <div className="min-w-0 flex-1">
            {user ? renderWorkspaceDropdown() : (
              <div className="truncate text-[1rem] font-semibold text-text">TheChat</div>
            )}
          </div>
          {user && (
            <button
              className="ml-2 flex size-8 cursor-pointer items-center justify-center rounded-md border-none bg-transparent text-text-muted transition-colors duration-150 hover:bg-hover hover:text-text"
              onClick={() => navigate({ to: "/notifications" })}
              aria-label="Notifications"
              title="Notifications"
            >
              <BellIcon />
              {notificationCount > 0 && (
                <span className="absolute mt-[-18px] ml-[18px] size-2 rounded-full bg-accent" />
              )}
            </button>
          )}
        </div>

        <div className="border-b border-border-subtle px-3 py-3">
          <button
            className="mb-3 flex w-full cursor-pointer items-center justify-center gap-2 rounded-md border border-[rgba(47,136,191,0.5)] bg-[rgba(47,136,191,0.2)] px-3 py-2 font-[inherit] text-[0.95rem] text-text-secondary transition-colors duration-150 hover:bg-[rgba(47,136,191,0.3)] hover:text-text"
            onClick={handleNewChat}
          >
            <PlusIcon className="shrink-0" />
            <span>New Chat</span>
          </button>

          <label className="flex h-9 items-center gap-2 rounded-md bg-[#383d4a] px-3 text-text-muted focus-within:ring-1 focus-within:ring-border-focus">
            <SearchIcon className="shrink-0" />
            <input
              className="min-w-0 flex-1 border-none bg-transparent p-0 font-[inherit] text-[0.95rem] text-text outline-none placeholder:text-text-muted"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Search"
            />
          </label>

          {user && activeWorkspace && (
            <div className="mt-3 flex gap-0.5 rounded-md bg-[#383d4a] p-0.5">
              <button
                className={`flex flex-1 cursor-pointer items-center justify-center gap-1 rounded px-2 py-1.5 font-[inherit] text-[0.9rem] transition-colors duration-150 ${tab === "agent" ? "bg-surface text-text-secondary" : "bg-transparent text-text-muted hover:text-text"}`}
                onClick={() => setTab("agent")}
              >
                Agent Chats
                {unreadAgentChats.size > 0 && tab !== "agent" && (
                  <span className="size-1.5 shrink-0 rounded-full bg-accent" />
                )}
              </button>
              <button
                className={`flex flex-1 cursor-pointer items-center justify-center gap-1 rounded px-2 py-1.5 font-[inherit] text-[0.9rem] transition-colors duration-150 ${tab === "workspace" ? "bg-surface text-text-secondary" : "bg-transparent text-text-muted hover:text-text"}`}
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
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 py-2">
            {/* Channels */}
            <div>
              {renderSectionLabel("Channels")}
              <div className="pb-1">
                {activeWorkspace.channels
                  .filter((ch) => !normalizedSearch || ch.name.toLowerCase().includes(normalizedSearch) || ch.title?.toLowerCase().includes(normalizedSearch))
                  .map((ch) => {
                  const isActive = activeChannelId === ch.id;
                  const isUnread = unreadChannels.has(ch.id);
                  return (
                    <button
                      key={ch.id}
                      className={itemClassName(isActive, isUnread)}
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
                      className={itemClassName(isActive)}
                      onClick={() => handleSelectDm(m)}
                    >
                      <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-elevated text-[0.714rem] font-semibold text-text-muted">
                      {m.user.name.charAt(0).toUpperCase()}
                    </span>
                    <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">{m.user.name}</span>
                  </button>
                );
              };

              return (
                <div>
                  {humans.length > 0 && (
                    <>
                      {renderSectionLabel("People")}
                      <div className="pb-1">
                        {humans
                          .filter((m) => !normalizedSearch || m.user.name.toLowerCase().includes(normalizedSearch))
                          .map(renderMember)}
                      </div>
                    </>
                  )}
                  {bots.length > 0 && (
                    <>
                      {renderSectionLabel("Bots")}
                      <div className="pb-1">
                        {bots
                          .filter((m) => !normalizedSearch || m.user.name.toLowerCase().includes(normalizedSearch))
                          .map(renderMember)}
                      </div>
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
            <div className="flex-1 overflow-y-auto px-3 pt-2">
              {activeWorkspace && user && renderSectionLabel("Recent")}
              {filteredConversations.map((conv) => {
                const isActive = currentAgentChatId === conv.id;
                const isUnread = !isActive && unreadAgentChats.has(conv.id);
                const isStreamingBg = !isActive && streamingConvIds.has(conv.id);
                return (
                  <button
                    key={conv.id}
                    className={itemClassName(isActive, isUnread)}
                    onClick={() => handleSelectConversation(conv)}
                  >
                    <MessageIcon />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{conv.title}</span>
                      {conv.project_dir && (
                        <ProjectDirLabel path={conv.project_dir} />
                      )}
                    </span>
                    {isStreamingBg && <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-accent" />}
                    {!isStreamingBg && isUnread && <span className="size-1.5 shrink-0 rounded-full bg-accent" />}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="border-t border-border-subtle px-3 py-2">
          {import.meta.env.DEV && (
            <button
              className={`mb-1.5 flex w-full cursor-pointer items-center gap-2 rounded-md border-none px-2 py-1.5 text-left font-[inherit] text-[0.857rem] transition-colors duration-150 ${isScrollDebug ? "bg-elevated text-text" : "bg-transparent text-text-secondary hover:bg-hover hover:text-text"}`}
              onClick={() => navigate({ to: "/debug/scroll" })}
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                <path d="M2.33 3.5h9.34" />
                <path d="M2.33 7h9.34" />
                <path d="M2.33 10.5h9.34" />
                <path d="M4.67 2.33v2.34" />
                <path d="M9.33 5.83v2.34" />
                <path d="M6.42 9.33v2.34" />
              </svg>
              Scroll Debug
            </button>
          )}
          {import.meta.env.DEV && (
            <button
              className={`mb-1.5 flex w-full cursor-pointer items-center gap-2 rounded-md border-none px-2 py-1.5 text-left font-[inherit] text-[0.857rem] transition-colors duration-150 ${isHermesDebug ? "bg-elevated text-text" : "bg-transparent text-text-secondary hover:bg-hover hover:text-text"}`}
              onClick={() => navigate({ to: "/debug/hermes" })}
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="7" cy="7" r="5.2" />
                <path d="M7 4.5v2.8l1.9 1.2" />
              </svg>
              Hermes Debug
            </button>
          )}
          {user ? (
            <div className="relative" ref={profileMenuRef}>
              <button
                className="flex w-full cursor-pointer items-center justify-between gap-2 rounded-md border border-border bg-raised px-2 py-2 text-left font-[inherit] transition-colors duration-150 hover:bg-hover"
                onClick={() => setProfileMenuOpen((v) => !v)}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-elevated text-[0.857rem] font-semibold text-text">
                    {initials}
                  </span>
                  <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[0.857rem] font-medium text-text-secondary">
                    {user.name}
                  </span>
                </span>
                <ChevronDownIcon open={profileMenuOpen} />
              </button>

              <button
                className="mt-1.5 flex w-full cursor-pointer items-center justify-between rounded-md border-none bg-transparent px-2 py-1.5 text-[0.857rem] text-text-secondary transition-colors duration-150 hover:bg-hover hover:text-text"
                onClick={() => navigate({ to: "/notifications" })}
              >
                <span className="flex items-center gap-2">
                  <BellIcon />
                  Notifications
                </span>
                {notificationCount > 0 && (
                  <span className="min-w-[18px] rounded-full bg-accent px-1.5 py-px text-center text-[0.714rem] font-semibold text-white">
                    {notificationCount}
                  </span>
                )}
              </button>

              {profileMenuOpen && (
                <div className="absolute right-0 bottom-[calc(100%+6px)] z-20 min-w-[220px] overflow-hidden rounded-lg border border-border-strong bg-surface shadow-card animate-fade-in">
                  <button
                    className="flex w-full cursor-pointer items-center justify-between gap-2 border-none bg-transparent px-3 py-2.5 text-left font-[inherit] text-[0.857rem] text-text-secondary transition-colors duration-100 hover:bg-hover hover:text-text"
                    onClick={() => {
                      openCodexAuthModal();
                      setProfileMenuOpen(false);
                    }}
                  >
                    <span>ChatGPT</span>
                    <span className={`text-[0.786rem] ${codexStatus === "authenticated" ? "text-success" : "text-text-dimmed"}`}>
                      {codexStatus === "authenticated" ? "Connected" : "Not connected"}
                    </span>
                  </button>
                  <button
                    className="flex w-full cursor-pointer items-center justify-between gap-2 border-none bg-transparent px-3 py-2.5 text-left font-[inherit] text-[0.857rem] text-text-secondary transition-colors duration-100 hover:bg-hover hover:text-text"
                    onClick={() => {
                      navigate({ to: "/notifications" });
                      setProfileMenuOpen(false);
                    }}
                  >
                    <span>Notifications</span>
                    {notificationCount > 0 && (
                      <span className="min-w-[18px] rounded-full bg-accent px-1.5 py-px text-center text-[0.714rem] font-semibold text-white">
                        {notificationCount}
                      </span>
                    )}
                  </button>
                  <button
                    className="block w-full cursor-pointer border-none bg-transparent px-3 py-2.5 text-left font-[inherit] text-[0.857rem] text-text-secondary transition-colors duration-100 hover:bg-hover hover:text-text"
                    onClick={() => {
                      navigate({ to: "/settings" });
                      setProfileMenuOpen(false);
                    }}
                  >
                    Settings
                  </button>
                  <button
                    className="block w-full cursor-pointer border-t border-border bg-transparent px-3 py-2.5 text-left font-[inherit] text-[0.857rem] text-text-dimmed transition-colors duration-100 hover:bg-hover hover:text-text"
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
                className={`flex w-full cursor-pointer items-center gap-2 rounded-md border-none px-2 py-1.5 text-left font-[inherit] text-[0.857rem] transition-colors duration-150 ${isSettings ? "bg-elevated text-text" : "bg-transparent text-text-secondary hover:bg-hover hover:text-text"}`}
                onClick={() => navigate({ to: "/settings" })}
              >
                <SettingsIcon />
                Settings
              </button>
              <button
                className="flex w-full cursor-pointer items-center justify-between rounded-md border-none bg-transparent px-2 py-1.5 text-left font-[inherit] text-[0.857rem] text-text-secondary transition-colors duration-150 hover:bg-hover hover:text-text"
                onClick={openCodexAuthModal}
              >
                <span className="flex items-center gap-2">
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M7 1.17 8.46 4.7l3.87.34-2.95 2.54.88 3.8L7 9.42l-3.26 1.96.88-3.8-2.95-2.54 3.87-.34Z" />
                  </svg>
                  ChatGPT
                </span>
                <span className={`text-[0.786rem] ${codexStatus === "authenticated" ? "text-success" : "text-text-dimmed"}`}>
                  {codexStatus === "authenticated" ? "Connected" : "Not connected"}
                </span>
              </button>
              <button
                className="mt-1 flex w-full cursor-pointer items-center justify-center gap-1.5 rounded-md border border-border bg-raised px-2.5 py-2 font-[inherit] text-[0.857rem] font-medium text-text-secondary transition-colors duration-150 hover:bg-hover hover:text-text"
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
    </div>
  );
}
