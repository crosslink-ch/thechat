import { useState } from "react";
import type { Conversation } from "../core/types";
import type {
  AuthUser,
  WorkspaceListItem,
  WorkspaceWithDetails,
  WorkspaceChannel,
  WorkspaceMember,
} from "@thechat/shared";
import { useStreamingConvIds } from "../stores/streaming";

interface SidebarProps {
  open: boolean;
  conversations: Conversation[];
  currentId: string | undefined;
  user: AuthUser | null;
  workspaces: WorkspaceListItem[];
  activeWorkspace: WorkspaceWithDetails | null;
  onClose: () => void;
  onNewChat: () => void;
  onSelectConversation: (conv: Conversation) => void;
  onLoginClick: () => void;
  onLogout: () => void;
  onSelectWorkspace: (id: string) => void;
  onOpenWorkspaceModal: () => void;
  onSelectChannel?: (channel: WorkspaceChannel) => void;
  onSelectDm?: (member: WorkspaceMember) => void;
  activeChannelId?: string | null;
  activeDmUserId?: string | null;
  unreadChannels?: Set<string>;
  unreadAgentChats?: Set<string>;
}

export function Sidebar({
  open,
  conversations,
  currentId,
  user,
  workspaces,
  activeWorkspace,
  onClose,
  onNewChat,
  onSelectConversation,
  onLoginClick,
  onLogout,
  onSelectWorkspace,
  onOpenWorkspaceModal,
  onSelectChannel,
  onSelectDm,
  activeChannelId,
  activeDmUserId,
  unreadChannels,
  unreadAgentChats,
}: SidebarProps) {
  const streamingConvIds = useStreamingConvIds();
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [agentChatsCollapsed, setAgentChatsCollapsed] = useState(false);

  return (
    <>
      {open && <div className="sidebar-overlay" onClick={onClose} />}
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
                      onSelectWorkspace(ws.id);
                      setDropdownOpen(false);
                    }}
                  >
                    {ws.name}
                  </button>
                ))}
                <button
                  className="workspace-dropdown-item workspace-dropdown-action"
                  onClick={() => {
                    onOpenWorkspaceModal();
                    setDropdownOpen(false);
                  }}
                >
                  + Create or join
                </button>
              </div>
            )}
          </div>
        )}

        {/* Workspace content: channels + DMs */}
        {user && activeWorkspace && (
          <>
            <div className="sidebar-section">
              <div className="sidebar-section-header">Channels</div>
              <div className="sidebar-section-list">
                {activeWorkspace.channels.map((ch) => {
                  const isActive = activeChannelId === ch.id;
                  const isUnread = unreadChannels?.has(ch.id);
                  return (
                    <button
                      key={ch.id}
                      className={`channel-item ${isActive ? "channel-item-active" : ""} ${isUnread ? "channel-item-unread" : ""}`}
                      onClick={() => onSelectChannel?.(ch)}
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
                        onClick={() => onSelectDm?.(m)}
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

            <div className="sidebar-divider" />
          </>
        )}

        {/* Agent Chats section */}
        <div className="sidebar-section sidebar-section-agent">
          {user && activeWorkspace ? (
            <button
              className="sidebar-section-header sidebar-section-toggle"
              onClick={() => setAgentChatsCollapsed(!agentChatsCollapsed)}
            >
              <span className="sidebar-section-chevron">
                {agentChatsCollapsed ? "\u25B6" : "\u25BC"}
              </span>
              Agent Chats
            </button>
          ) : (
            <div className="sidebar-section-header">Agent Chats</div>
          )}

          {!agentChatsCollapsed && (
            <>
              <button className="new-chat-btn" onClick={onNewChat}>
                + New Chat
              </button>
              <div className="conversations-list">
                {conversations.map((conv) => {
                  const isActive = currentId === conv.id;
                  const isUnread = !isActive && unreadAgentChats?.has(conv.id);
                  const isStreamingBg = !isActive && streamingConvIds?.has(conv.id);
                  return (
                    <button
                      key={conv.id}
                      className={`conv-item ${isActive ? "conv-active" : ""} ${isUnread ? "conv-unread" : ""}`}
                      onClick={() => onSelectConversation(conv)}
                    >
                      <span className="conv-title">{conv.title}</span>
                      {isStreamingBg && <span className="conv-streaming-indicator" />}
                      {!isStreamingBg && isUnread && <span className="conv-unread-dot" />}
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>

        <div className="sidebar-footer">
          {user ? (
            <div className="sidebar-user-info">
              <span className="sidebar-user-name">{user.name}</span>
              <button className="sidebar-logout-btn" onClick={onLogout}>
                Log out
              </button>
            </div>
          ) : (
            <button className="sidebar-login-btn" onClick={onLoginClick}>
              Log in
            </button>
          )}
        </div>
      </div>
    </>
  );
}
