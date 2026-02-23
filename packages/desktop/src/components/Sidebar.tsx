import { useState, useEffect } from "react";
import { create } from "zustand";
import { useNavigate, useMatches } from "@tanstack/react-router";
import { useAuthStore } from "../stores/auth";
import { useWorkspacesStore } from "../stores/workspaces";
import { useConversationsStore } from "../stores/conversations";
import { useStreamingConvIds } from "../stores/streaming";
import { useNotificationsStore } from "../stores/notifications";
import { openAuthModal } from "./AuthModal";
import { openWorkspaceModal } from "./WorkspaceModal";
import { resetTodos } from "../core/todo";
import { api } from "../lib/api";
import { basename } from "../lib/path";
import type { WorkspaceChannel, WorkspaceMember } from "@thechat/shared";

function ProjectDirLabel({ path }: { path: string }) {
  const [name, setName] = useState<string | null>(null);
  useEffect(() => {
    basename(path).then(setName);
  }, [path]);
  if (!name) return null;
  return <span className="conv-project">{name}</span>;
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
    resetTodos();
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
      {open && <div className="sidebar-overlay" onClick={closeSidebar} />}
      <div className={`sidebar ${open ? "sidebar-open" : ""}`}>
        {/* Workspace switcher (only when logged in) */}
        {user && (
          <div className="workspace-switcher">
            <button
              className="workspace-switcher-btn"
              onClick={() => setDropdownOpen(!dropdownOpen)}
            >
              <span className="workspace-switcher-name">
                {activeWorkspace ? activeWorkspace.name : "Select workspace"}
              </span>
              <span className="workspace-switcher-chevron">
                {dropdownOpen ? "\u25B2" : "\u25BC"}
              </span>
            </button>
            {dropdownOpen && (
              <div className="workspace-dropdown">
                {workspaces.map((ws) => (
                  <button
                    key={ws.id}
                    className={`workspace-dropdown-item ${
                      activeWorkspace?.id === ws.id
                        ? "workspace-dropdown-active"
                        : ""
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
                  className="workspace-dropdown-item workspace-dropdown-action"
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
          <div className="sidebar-tabs">
            <button
              className={`sidebar-tab ${tab === "workspace" ? "sidebar-tab-active" : ""}`}
              onClick={() => setTab("workspace")}
            >
              Workspace
              {unreadChannels.size > 0 && tab !== "workspace" && (
                <span className="sidebar-tab-badge" />
              )}
            </button>
            <button
              className={`sidebar-tab ${tab === "agent" ? "sidebar-tab-active" : ""}`}
              onClick={() => setTab("agent")}
            >
              Agent Chats
              {unreadAgentChats.size > 0 && tab !== "agent" && (
                <span className="sidebar-tab-badge" />
              )}
            </button>
          </div>
        )}

        {/* Workspace tab content */}
        {user && activeWorkspace && tab === "workspace" && (
          <>
            {/* Notifications button */}
            <button
              className="sidebar-notifications-btn"
              onClick={() => {
                navigate({ to: "/notifications" });
                closeSidebar();
              }}
            >
              <span>Notifications</span>
              {notificationCount > 0 && (
                <span className="sidebar-notifications-badge">
                  {notificationCount}
                </span>
              )}
            </button>

            <div className="sidebar-section">
              <div className="sidebar-section-header">Channels</div>
              <div className="sidebar-section-list">
                {activeWorkspace.channels.map((ch) => {
                  const isActive = activeChannelId === ch.id;
                  const isUnread = unreadChannels.has(ch.id);
                  return (
                    <button
                      key={ch.id}
                      className={`channel-item ${isActive ? "channel-item-active" : ""} ${isUnread ? "channel-item-unread" : ""}`}
                      onClick={() => handleSelectChannel(ch)}
                    >
                      <span className="channel-hash">#</span> {ch.name}
                      {isUnread && <span className="channel-unread-dot" />}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="sidebar-section">
              <div className="sidebar-section-header">Direct Messages</div>
              <div className="sidebar-section-list">
                {activeWorkspace.members
                  .filter((m) => m.userId !== user.id)
                  .map((m) => {
                    const isActive = activeDmUserId === m.userId;
                    return (
                      <button
                        key={m.userId}
                        className={`dm-item ${isActive ? "dm-item-active" : ""}`}
                        onClick={() => handleSelectDm(m)}
                      >
                        <span className="dm-avatar">
                          {m.user.name.charAt(0).toUpperCase()}
                        </span>
                        <span className="dm-name">{m.user.name}</span>
                      </button>
                    );
                  })}
              </div>
            </div>
          </>
        )}

        {/* Agent Chats tab content (or full view when no workspace) */}
        {(tab === "agent" || !activeWorkspace || !user) && (
          <div className="sidebar-section sidebar-section-agent">
            <button className="new-chat-btn" onClick={handleNewChat}>
              + New Chat
            </button>
            <div className="conversations-list">
              {conversations.map((conv) => {
                const isActive = currentAgentChatId === conv.id;
                const isUnread = !isActive && unreadAgentChats.has(conv.id);
                const isStreamingBg = !isActive && streamingConvIds.has(conv.id);
                return (
                  <button
                    key={conv.id}
                    className={`conv-item ${isActive ? "conv-active" : ""} ${isUnread ? "conv-unread" : ""}`}
                    onClick={() => handleSelectConversation(conv)}
                  >
                    <span className="conv-title">{conv.title}</span>
                    {conv.project_dir && (
                      <ProjectDirLabel path={conv.project_dir} />
                    )}
                    {isStreamingBg && <span className="conv-streaming-indicator" />}
                    {!isStreamingBg && isUnread && <span className="conv-unread-dot" />}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <div className="sidebar-footer">
          {user ? (
            <div className="sidebar-user-info">
              <span className="sidebar-user-name">{user.name}</span>
              <button className="sidebar-logout-btn" onClick={logout}>
                Log out
              </button>
            </div>
          ) : (
            <button className="sidebar-login-btn" onClick={openAuthModal}>
              Log in
            </button>
          )}
        </div>
      </div>
    </>
  );
}
