import { PlatformSidebarUpdate } from "#platform-shell";
import { authHeaders } from "../lib/eden";
import { isAuthenticated } from "../lib/auth-identity";
import { useNavigationDismiss } from "./ResponsiveShell";
import { useState, useEffect, useRef } from "react";
import { create } from "zustand";
import { useNavigate, useMatches } from "@tanstack/react-router";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useAuthStore } from "../stores/auth";
import { useWorkspacesStore } from "../stores/workspaces";
import { useConversationsStore } from "../stores/conversations";
import { useNotificationsStore } from "../stores/notifications";
import { useActivityStore } from "../stores/activity";
import { usePresenceStore } from "../stores/presence";
import { openAuthModal } from "./AuthModal";
import { openWorkspaceModal } from "./WorkspaceModal";
import {
  openCreateChannelModal,
  openDeleteChannelModal,
  openRenameChannelModal,
} from "./ChannelModal";
import { api } from "../lib/api";
import type { WorkspaceChannel, WorkspaceMember } from "@thechat/shared";
import { Bell, Bot, ChevronDown, Ellipsis, LogIn, LogOut, Pencil, Plus, Settings, Trash2 } from "lucide-react";
import { Avatar } from "./Avatar";
import {
  avatarColor,
  buttonClass,
  iconButtonClass,
  menuContentClass,
  menuDangerItemClass,
  menuItemBaseClass,
  menuItemClass,
  menuSeparatorClass,
  sectionLabelClass,
} from "./ui";

const SIDEBAR_WIDTH = 347;

function Chevron({ open = false }: { open?: boolean }) {
  return (
    <ChevronDown
      size={14}
      aria-hidden="true"
      className={`shrink-0 text-text-dimmed transition-transform duration-150 ${open ? "rotate-180" : ""}`}
    />
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
  const routerNavigate = useNavigate();
  const dismissNavigation = useNavigationDismiss();
  const navigate: typeof routerNavigate = (options) => {
    dismissNavigation?.();
    return routerNavigate(options);
  };
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

  const setActiveDirectConversation = useConversationsStore(
    (s) => s.setActiveDirectConversation,
  );
  const notificationCount = useNotificationsStore((s) => s.notifications.length);
  const activityItems = useActivityStore((s) => s.items);
  const unreadMessageCount = useActivityStore((s) => s.totalUnreadMessages);
  const onlineUserIds = usePresenceStore((s) => s.onlineUserIds);

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
  const activityCount = unreadMessageCount + notificationCount;
  const unreadActivityConversationIds = new Set(
    activityItems.map((item) => item.conversationId),
  );
  const unreadActivitySenderIds = new Set(
    activityItems
      .filter(
        (item) =>
          item.conversationType === "direct" &&
          item.workspaceId === activeWorkspace?.id,
      )
      .map((item) => item.latestMessage.senderId),
  );
  const unreadWorkspaceIds = new Set(
    activityItems.map((item) => item.workspaceId),
  );
  const otherUnreadWorkspaceCount = [...unreadWorkspaceIds].filter(
    (workspaceId) => workspaceId !== activeWorkspace?.id,
  ).length;

  const handleSelectChannel = (channel: WorkspaceChannel) => {
    navigate({ to: "/channel/$id", params: { id: channel.id } });
    useConversationsStore.getState().markChannelRead(channel.id);
  };

  const handleSelectDm = async (member: WorkspaceMember) => {
    if (!isAuthenticated(token) || !activeWorkspace) return;
    try {
      const { data, error } = await api.conversations.dm.post(
        { workspaceId: activeWorkspace.id, otherUserId: member.userId },
        authHeaders(token),
      );
      if (error) throw error;
      if (data && "id" in data) {
        useConversationsStore
          .getState()
          .rememberDirectConversation(member.userId, data.id!);
        useConversationsStore.getState().setActiveDirectConversation(data.id!);
        navigate({
          to: "/dm/$id",
          params: { id: data.id! },
          search: { threadId: undefined },
        });
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
        <Chevron open={dropdownOpen} />
      </button>
      {dropdownOpen && (
        <div className={`absolute top-full right-0 left-0 z-[15] mt-3 ${menuContentClass}`}>
          {workspaces.map((ws) => {
            const hasUnread = unreadWorkspaceIds.has(ws.id);
            return (
              <button
                key={ws.id}
                className={`${menuItemBaseClass} ${
                  activeWorkspace?.id === ws.id
                    ? "bg-hover text-text"
                    : "text-text-secondary hover:bg-hover hover:text-text"
                }`}
                aria-label={`${ws.name}${hasUnread ? ", unread messages" : ""}`}
                onClick={() => {
                  selectWorkspace(ws.id);
                  setDropdownOpen(false);
                  setProfileMenuOpen(false);
                }}
              >
                <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
                  {ws.name}
                </span>
                {hasUnread && (
                  <span
                    data-testid={`workspace-unread-indicator-${ws.id}`}
                    className="size-2 shrink-0 rounded-full bg-accent"
                    aria-hidden="true"
                  />
                )}
              </button>
            );
          })}
          <div className={menuSeparatorClass} />
          <button
            className={`${menuItemBaseClass} text-accent hover:bg-hover`}
            onClick={() => {
              openWorkspaceModal();
              setDropdownOpen(false);
              setProfileMenuOpen(false);
            }}
          >
            <Plus size={14} aria-hidden="true" />
            Create workspace
          </button>
        </div>
      )}
    </div>
  );

  const renderSectionLabel = (label: string, onAdd?: () => void) => (
    <div className={`flex items-center justify-between pb-1.5 pl-2.5 pr-1 pt-4 ${sectionLabelClass}`}>
      <span>{label}</span>
      {onAdd && (
        <button
          type="button"
          onClick={onAdd}
          className={iconButtonClass("sm")}
          aria-label={`Create ${label.toLowerCase().replace(/s$/, "")}`}
          title={`Create ${label.toLowerCase().replace(/s$/, "")}`}
        >
          <Plus size={14} aria-hidden="true" />
        </button>
      )}
    </div>
  );

  const itemClassName = (active: boolean, unread = false) =>
    [
      "group flex w-full cursor-pointer items-center gap-2.5 rounded-lg border-none px-2.5 py-1.5 text-left font-[inherit] text-[1rem] transition-colors duration-100",
      active
        ? "bg-elevated text-text"
        : unread
          ? "text-text hover:bg-hover"
          : "text-text-muted hover:bg-hover hover:text-text",
      unread ? "font-semibold" : "",
    ].join(" ");

  return (
    <div
      className="app-sidebar flex h-full shrink-0 border-r border-border-subtle bg-surface transition-[margin-left] duration-200 ease-out"
      style={{ width: SIDEBAR_WIDTH, marginLeft: open ? 0 : -SIDEBAR_WIDTH }}
    >
      <div className="flex w-[57px] shrink-0 flex-col items-center border-r border-border-subtle bg-sunken py-2">
        <button
          className="relative flex size-9 cursor-pointer items-center justify-center rounded-lg text-[0.9rem] font-bold text-white ring-1 ring-inset ring-white/10 transition-[filter] duration-150 hover:brightness-110"
          style={{ backgroundColor: avatarColor(activeWorkspace?.id ?? "thechat") }}
          onClick={() => {
            if (user) setDropdownOpen((open) => !open);
          }}
          aria-label={
            otherUnreadWorkspaceCount > 0
              ? `Current workspace, ${otherUnreadWorkspaceCount} other ${
                  otherUnreadWorkspaceCount === 1 ? "workspace" : "workspaces"
                } with unread messages`
              : "Current workspace"
          }
          title={activeWorkspace?.name ?? "TheChat"}
        >
          <span className="absolute -left-[11px] h-[30px] w-0.5 rounded-r-sm bg-accent" />
          {workspaceInitial}
          {otherUnreadWorkspaceCount > 0 && (
            <span
              data-testid="other-workspace-unread-count"
              className="absolute -right-2 -top-2 min-w-[17px] rounded-full bg-accent px-1 text-center text-[0.643rem] font-semibold leading-[17px] text-white"
            >
              {otherUnreadWorkspaceCount > 9 ? "9+" : otherUnreadWorkspaceCount}
            </span>
          )}
        </button>

        <button
          className="mt-3 flex size-9 cursor-pointer items-center justify-center rounded-lg border border-dashed border-border-strong bg-transparent text-text-dimmed transition-colors duration-150 hover:border-accent hover:text-text"
          onClick={openWorkspaceModal}
          aria-label="Create workspace"
          title="Create workspace"
        >
          <Plus size={16} aria-hidden="true" />
        </button>
      </div>

      <div className="flex min-w-0 flex-1 flex-col bg-surface">
        <div className="flex h-[48px] shrink-0 items-center justify-between border-b border-border-subtle px-3">
          <div className="min-w-0 flex-1">
            {user ? renderWorkspaceDropdown() : (
              <div className="truncate text-[1rem] font-semibold text-text">TheChat</div>
            )}
          </div>
          {user && (
            <button
              className={`relative ml-2 ${iconButtonClass("md")}`}
              onClick={() => navigate({ to: "/activity" })}
              aria-label={
                activityCount > 0
                  ? `Activity, ${activityCount} unread items`
                  : "Activity"
              }
              title="Activity"
            >
              <Bell size={16} aria-hidden="true" />
              {activityCount > 0 && (
                <span
                  data-testid="activity-unread-count"
                  className="absolute -right-1.5 -top-1.5 min-w-[16px] rounded-full bg-accent px-1 text-center text-[0.571rem] font-semibold leading-4 text-white"
                >
                  {activityCount > 99 ? "99+" : activityCount}
                </span>
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
                    const isUnread =
                      unreadChannels.has(ch.id) ||
                      unreadActivityConversationIds.has(ch.id);
                    const menuOpen = channelMenuId === ch.id;
                    return (
                      <div key={ch.id} className="group relative">
                        <button
                          data-channel-id={ch.id}
                          className={`${itemClassName(isActive, isUnread)} ${canManageChannels ? "pr-9" : ""}`}
                          onClick={() => handleSelectChannel(ch)}
                          aria-current={isActive ? "page" : undefined}
                        >
                          <span className="w-4 shrink-0 text-center text-text-dimmed">#</span>
                          <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">{ch.name}</span>
                          {isUnread && (
                            <span
                              data-testid={`channel-unread-indicator-${ch.id}`}
                              className="size-1.5 shrink-0 rounded-full bg-accent"
                            />
                          )}
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
                                className={`absolute right-1 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-text-dimmed transition-all hover:bg-hover hover:text-text focus:opacity-100 ${
                                  menuOpen ? "bg-hover text-text opacity-100" : "opacity-0 group-hover:opacity-100"
                                }`}
                                aria-label={`Manage #${ch.name}`}
                              >
                                <Ellipsis size={16} aria-hidden="true" />
                              </button>
                            </DropdownMenu.Trigger>
                            <DropdownMenu.Portal>
                              <DropdownMenu.Content
                                align="end"
                                sideOffset={4}
                                loop
                                className={`z-50 ${menuContentClass}`}
                              >
                                <DropdownMenu.Item
                                  asChild
                                  onSelect={() => openRenameChannelModal(ch)}
                                >
                                  <button
                                    type="button"
                                    className={menuItemClass}
                                  >
                                    <Pencil size={14} className="text-text-dimmed" aria-hidden="true" />
                                    Rename channel
                                  </button>
                                </DropdownMenu.Item>
                                <DropdownMenu.Item
                                  asChild
                                  onSelect={() => openDeleteChannelModal(ch)}
                                >
                                  <button
                                    type="button"
                                    className={menuDangerItemClass}
                                  >
                                    <Trash2 size={14} aria-hidden="true" />
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
                  const isActive =
                    activeDmConversationId === directConversationIdsByUserId[m.userId];
                  const isUnread = unreadActivitySenderIds.has(m.userId);
                  const isOnline =
                    m.user.type === "human" && onlineUserIds.has(m.userId);
                  const ariaLabel = [
                    m.user.name,
                    isUnread ? "unread" : null,
                    isOnline ? "online" : null,
                  ]
                    .filter(Boolean)
                    .join(", ");
                  return (
                    <button
                      key={m.userId}
                      className={itemClassName(isActive, isUnread)}
                      onClick={() => handleSelectDm(m)}
                      aria-label={ariaLabel}
                      aria-current={isActive ? "page" : undefined}
                    >
                      <Avatar name={m.user.name} colorKey={m.userId} bot={m.user.type === "bot"} className="size-5 text-[0.643rem]">
                        {isOnline && (
                          <span
                            data-testid={`online-indicator-${m.userId}`}
                            className="absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full border-2 border-surface bg-success"
                            title="Online"
                            aria-hidden="true"
                          />
                        )}
                      </Avatar>
                      <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">{m.user.name}</span>
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
              <div className="mt-4 rounded-xl border border-border-subtle bg-white/[0.03] px-3 py-3">
                <div className="text-[0.929rem] font-medium text-text-secondary">
                  {user ? "No workspace selected" : "Workspace"}
                </div>
                <div className="mt-1 text-[0.786rem] text-text-dimmed">
                  {user ? "Choose a workspace above or create one." : "Log in to view workspace channels and DMs."}
                </div>
                {user && (
                  <button
                    className={`mt-3 w-full ${buttonClass("secondary", "md")}`}
                    onClick={openWorkspaceModal}
                  >
                    <Plus size={14} aria-hidden="true" />
                    Create workspace
                  </button>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="shrink-0 border-t border-border-subtle px-3 py-2">
          <PlatformSidebarUpdate />
          {user ? (
            <div className="relative" ref={profileMenuRef}>
              <button
                className={`flex w-full cursor-pointer items-center justify-between gap-2 rounded-lg border-none px-2 py-1.5 text-left font-[inherit] transition-colors duration-150 hover:bg-hover ${profileMenuOpen ? "bg-hover" : ""}`}
                onClick={() => setProfileMenuOpen((v) => !v)}
              >
                <span className="flex min-w-0 items-center gap-2.5">
                  <Avatar name={initials} colorKey={user.id} className="size-6 text-[0.786rem]" />
                  <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[1rem] font-medium text-text-secondary">
                    {user.name}
                  </span>
                </span>
                <Chevron open={profileMenuOpen} />
              </button>

              {profileMenuOpen && (
                <div className={`absolute right-0 left-0 bottom-[calc(100%+6px)] z-20 ${menuContentClass}`}>
                  <button
                    className={menuItemClass}
                    onClick={() => {
                      navigate({ to: "/activity" });
                      setProfileMenuOpen(false);
                    }}
                  >
                    <Bell size={14} className="text-text-dimmed" aria-hidden="true" />
                    <span className="flex-1">Activity</span>
                    {activityCount > 0 && (
                      <span className="min-w-[18px] rounded-full bg-accent px-1.5 py-px text-center text-[0.714rem] font-semibold text-white">
                        {activityCount > 99 ? "99+" : activityCount}
                      </span>
                    )}
                  </button>
                  <button
                    className={menuItemClass}
                    onClick={() => {
                      navigate({ to: "/bots/manage" });
                      setProfileMenuOpen(false);
                    }}
                  >
                    <Bot size={14} className="text-text-dimmed" aria-hidden="true" />
                    Manage bots
                  </button>
                  <button
                    className={menuItemClass}
                    onClick={() => {
                      navigate({ to: "/settings" });
                      setProfileMenuOpen(false);
                    }}
                  >
                    <Settings size={14} className="text-text-dimmed" aria-hidden="true" />
                    Settings
                  </button>
                  <div className={menuSeparatorClass} />
                  <button
                    className={menuItemClass}
                    onClick={() => {
                      logout();
                      setProfileMenuOpen(false);
                    }}
                  >
                    <LogOut size={14} className="text-text-dimmed" aria-hidden="true" />
                    Log out
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-1">
              <button
                className={`flex w-full cursor-pointer items-center gap-2.5 rounded-lg border-none px-2.5 py-1.5 text-left font-[inherit] text-[1rem] transition-colors duration-150 ${isSettings ? "bg-elevated text-text" : "text-text-secondary hover:bg-hover hover:text-text"}`}
                onClick={() => navigate({ to: "/settings" })}
              >
                <Settings size={16} aria-hidden="true" />
                Settings
              </button>
              <button
                className={`mt-1 w-full ${buttonClass("secondary", "md")}`}
                onClick={() => openAuthModal()}
              >
                <LogIn size={14} aria-hidden="true" />
                Log in
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
