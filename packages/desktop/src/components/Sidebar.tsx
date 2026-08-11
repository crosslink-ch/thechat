import { useState, useEffect, useRef } from "react";
import { create } from "zustand";
import { useNavigate, useMatches } from "@tanstack/react-router";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useAuthStore } from "../stores/auth";
import { useWorkspacesStore } from "../stores/workspaces";
import { useConversationsStore } from "../stores/conversations";
import { useNotificationsStore } from "../stores/notifications";
import { openAuthModal } from "./AuthModal";
import { openWorkspaceModal } from "./WorkspaceModal";
import {
  openCreateChannelModal,
  openDeleteChannelModal,
  openRenameChannelModal,
} from "./ChannelModal";
import { api } from "../lib/api";
import type { WorkspaceChannel, WorkspaceMember } from "@thechat/shared";
import {
  directMemberNeedsAttention,
  scopeNeedsAttention,
  useNeedsAttentionStore,
} from "../stores/needs-attention";

const SIDEBAR_WIDTH = 347;

function PlusIcon({ className = "" }: { className?: string }) {
  return (
    <svg className={className} width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
      <path d="M7 3v8" />
      <path d="M3 7h8" />
    </svg>
  );
}

function MoreIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <circle cx="3" cy="8" r="1.2" />
      <circle cx="8" cy="8" r="1.2" />
      <circle cx="13" cy="8" r="1.2" />
    </svg>
  );
}

function PencilIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m9.6 2.3 2.1 2.1-6.8 6.8-2.8.7.7-2.8Z" />
      <path d="m8.2 3.7 2.1 2.1" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.5 4h9M5.3 2.2h3.4L9.3 4H4.7ZM4 6v5M7 6v5M10 6v5M3.5 4l.5 8h6l.5-8" />
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

function NeedsAttentionIndicator({ scopeId }: { scopeId: string }) {
  return (
    <span
      className="flex size-4 shrink-0 items-center justify-center rounded-full border border-warning-text/45 bg-warning-bg text-[0.643rem] font-bold leading-none text-warning-text"
      title="Needs attention"
      data-testid={`needs-attention-${scopeId}`}
      aria-hidden="true"
    >
      !
    </span>
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
  tab: "workspace" as "workspace" | "agent",
}));
export const toggleSidebar = () =>
  useSidebarState.setState((s) => ({ open: !s.open }));
export const closeSidebar = () => useSidebarState.setState({ open: false });

export function Sidebar() {
  const { open } = useSidebarState();
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
  const unreadChannels = useConversationsStore((s) => s.unreadChannels);
  const directConversationIdsByUserId = useConversationsStore(
    (s) => s.directConversationIdsByUserId,
  );
  const unreadBotConversations = useConversationsStore(
    (s) => s.unreadBotConversations,
  );
  const setActiveDirectConversation = useConversationsStore(
    (s) => s.setActiveDirectConversation,
  );
  const notificationCount = useNotificationsStore((s) => s.notifications.length);
  const needsAttentionScopes = useNeedsAttentionStore((s) => s.scopes);

  // Determine current active IDs from route
  const isChannel = routePath.startsWith("/channel");
  const isDm = routePath.startsWith("/dm");
  const isSettings = routePath === "/settings";
  const activeChannelId = isChannel ? routeParams.id : null;
  const activeDmConversationId = isDm ? routeParams.id : null;

  useEffect(() => {
    setActiveDirectConversation(activeDmConversationId);
  }, [activeDmConversationId, setActiveDirectConversation]);

  // Local UI state
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [channelMenuId, setChannelMenuId] = useState<string | null>(null);
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

  useEffect(() => setChannelMenuId(null), [activeWorkspace?.id]);

  const initials = user?.name?.trim().charAt(0).toUpperCase() ?? "?";
  const workspaceInitial = (activeWorkspace?.name ?? "TheChat").trim().charAt(0).toUpperCase();
  const currentMembership = activeWorkspace?.members.find(
    (member) => member.userId === user?.id,
  );
  const canManageChannels =
    currentMembership?.role === "owner" || currentMembership?.role === "admin";

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
        useConversationsStore
          .getState()
          .rememberDirectConversation(member.userId, data.id!);
        useConversationsStore.getState().setActiveDirectConversation(data.id!);
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

  const renderSectionLabel = (label: string, onAdd?: () => void) => (
    <div className="flex items-center justify-between px-1 pb-2 pt-4 text-[0.786rem] font-semibold uppercase tracking-[0.04em] text-text-dimmed">
      <span>{label}</span>
      {onAdd && (
        <button
          type="button"
          onClick={onAdd}
          className="flex size-5 items-center justify-center rounded text-text-dimmed transition-colors hover:bg-hover hover:text-text"
          aria-label={`Create ${label.toLowerCase().replace(/s$/, "")}`}
          title={`Create ${label.toLowerCase().replace(/s$/, "")}`}
        >
          <PlusIcon />
        </button>
      )}
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
            if (user) setDropdownOpen((open) => !open);
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

        <div className="flex min-h-0 flex-1 flex-col">
          {user && activeWorkspace ? (
            <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
              <div>
                {renderSectionLabel("Channels", openCreateChannelModal)}
                <div className="space-y-0.5 pb-1">
                  {activeWorkspace.channels.map((ch) => {
                    const isActive = activeChannelId === ch.id;
                    const isUnread = unreadChannels.has(ch.id);
                    const needsAttention = scopeNeedsAttention(
                      needsAttentionScopes,
                      ch.id,
                    );
                    const menuOpen = channelMenuId === ch.id;
                    return (
                      <div key={ch.id} className="group relative">
                        <button
                          data-channel-id={ch.id}
                          className={`${itemClassName(isActive, isUnread)} ${canManageChannels ? "pr-9" : ""}`}
                          onClick={() => handleSelectChannel(ch)}
                          aria-current={isActive ? "page" : undefined}
                          aria-label={`#${ch.name}${needsAttention ? ", needs attention" : ""}`}
                        >
                          <span className="w-4 shrink-0 text-center text-text-dimmed">#</span>
                          <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">{ch.name}</span>
                          {needsAttention && <NeedsAttentionIndicator scopeId={ch.id} />}
                          {isUnread && <span className="size-1.5 shrink-0 rounded-full bg-accent" />}
                        </button>
                        {canManageChannels && (
                          <DropdownMenu.Root
                            open={menuOpen}
                            onOpenChange={(nextOpen) =>
                              setChannelMenuId(nextOpen ? ch.id : null)
                            }
                          >
                            <DropdownMenu.Trigger asChild>
                              <button
                                type="button"
                                className={`absolute right-1 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded text-text-dimmed transition-all hover:bg-raised hover:text-text focus:opacity-100 ${
                                  menuOpen ? "bg-raised text-text opacity-100" : "opacity-0 group-hover:opacity-100"
                                }`}
                                aria-label={`Manage #${ch.name}`}
                              >
                                <MoreIcon />
                              </button>
                            </DropdownMenu.Trigger>
                            <DropdownMenu.Portal>
                              <DropdownMenu.Content
                                align="end"
                                sideOffset={4}
                                loop
                                className="z-50 min-w-[160px] overflow-hidden rounded-lg border border-border-strong bg-surface py-1 shadow-card animate-fade-in"
                              >
                                <DropdownMenu.Item
                                  asChild
                                  onSelect={() => openRenameChannelModal(ch)}
                                >
                                  <button
                                    type="button"
                                    className="flex w-full cursor-pointer items-center gap-2 border-none bg-transparent px-3 py-2 text-left text-[0.821rem] text-text-secondary outline-none transition-colors data-[highlighted]:bg-hover data-[highlighted]:text-text"
                                  >
                                    <span className="text-text-dimmed"><PencilIcon /></span>
                                    Rename channel
                                  </button>
                                </DropdownMenu.Item>
                                <DropdownMenu.Item
                                  asChild
                                  onSelect={() => openDeleteChannelModal(ch)}
                                >
                                  <button
                                    type="button"
                                    className="flex w-full cursor-pointer items-center gap-2 border-none bg-transparent px-3 py-2 text-left text-[0.821rem] text-red-400 outline-none transition-colors data-[highlighted]:bg-red-500/10 data-[highlighted]:text-red-300"
                                  >
                                    <TrashIcon />
                                    Delete channel
                                  </button>
                                </DropdownMenu.Item>
                              </DropdownMenu.Content>
                            </DropdownMenu.Portal>
                          </DropdownMenu.Root>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              {(() => {
                const others = activeWorkspace.members.filter((m) => m.userId !== user.id);
                const humans = others.filter((m) => m.user.type !== "bot");
                const bots = others.filter((m) => m.user.type === "bot");

                const renderMember = (m: WorkspaceMember) => {
                  const conversationId = directConversationIdsByUserId[m.userId];
                  const isActive =
                    activeDmConversationId === conversationId;
                  const isUnread =
                    m.user.type === "bot" &&
                    Object.values(unreadBotConversations).includes(m.userId);
                  const needsAttention = Boolean(
                    directMemberNeedsAttention(
                      needsAttentionScopes,
                      activeWorkspace.id,
                      m.userId,
                    ),
                  );
                  return (
                    <button
                      key={m.userId}
                      className={itemClassName(isActive, isUnread)}
                      onClick={() => handleSelectDm(m)}
                      aria-label={[
                        m.user.name,
                        isUnread ? "unread" : null,
                        needsAttention ? "needs attention" : null,
                      ]
                        .filter(Boolean)
                        .join(", ")}
                      aria-current={isActive ? "page" : undefined}
                    >
                      <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-elevated text-[0.714rem] font-semibold text-text-muted">
                        {m.user.name.charAt(0).toUpperCase()}
                      </span>
                      <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">{m.user.name}</span>
                      {needsAttention && (
                        <NeedsAttentionIndicator
                          scopeId={conversationId ?? `member-${m.userId}`}
                        />
                      )}
                      {isUnread && (
                        <span
                          className="size-1.5 shrink-0 rounded-full bg-accent"
                          aria-hidden="true"
                        />
                      )}
                    </button>
                  );
                };

                return (
                  <div>
                    {humans.length > 0 && (
                      <>
                        {renderSectionLabel("People")}
                        <div className="space-y-0.5 pb-1">
                          {humans.map(renderMember)}
                        </div>
                      </>
                    )}
                    {bots.length > 0 && (
                      <>
                        {renderSectionLabel("Bots")}
                        <div className="space-y-0.5 pb-1">
                          {bots.map(renderMember)}
                        </div>
                      </>
                    )}
                  </div>
                );
              })()}
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col px-4 py-4">
              <div className="mt-4 rounded-md border border-border-subtle bg-base/20 px-3 py-3">
                <div className="text-[0.929rem] font-medium text-text-secondary">
                  {user ? "No workspace selected" : "Workspace"}
                </div>
                <div className="mt-1 text-[0.786rem] text-text-dimmed">
                  {user ? "Choose a workspace above or create one." : "Log in to view workspace channels and DMs."}
                </div>
                {user && (
                  <button
                    className="mt-3 flex w-full cursor-pointer items-center justify-center gap-1.5 rounded-md border border-border bg-raised px-2.5 py-2 font-[inherit] text-[0.857rem] font-medium text-text-secondary transition-colors duration-150 hover:bg-hover hover:text-text"
                    onClick={openWorkspaceModal}
                  >
                    <PlusIcon className="shrink-0" />
                    Create workspace
                  </button>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-border-subtle px-3 py-2">
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

              {profileMenuOpen && (
                <div className="absolute right-0 bottom-[calc(100%+6px)] z-20 min-w-[220px] overflow-hidden rounded-lg border border-border-strong bg-surface shadow-card animate-fade-in">
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
                      navigate({ to: "/bots/manage" });
                      setProfileMenuOpen(false);
                    }}
                  >
                    Manage bots
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
                className="mt-1 flex w-full cursor-pointer items-center justify-center gap-1.5 rounded-md border border-border bg-raised px-2.5 py-2 font-[inherit] text-[0.857rem] font-medium text-text-secondary transition-colors duration-150 hover:bg-hover hover:text-text"
                onClick={() => openAuthModal()}
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
