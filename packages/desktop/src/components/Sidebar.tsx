import type { Conversation } from "../core/types";
import type { AuthUser } from "@thechat/shared";

interface SidebarProps {
  open: boolean;
  conversations: Conversation[];
  currentId: string | undefined;
  user: AuthUser | null;
  onClose: () => void;
  onNewChat: () => void;
  onSelectConversation: (conv: Conversation) => void;
  onLoginClick: () => void;
  onLogout: () => void;
}

export function Sidebar({
  open,
  conversations,
  currentId,
  user,
  onClose,
  onNewChat,
  onSelectConversation,
  onLoginClick,
  onLogout,
}: SidebarProps) {
  return (
    <>
      {open && <div className="sidebar-overlay" onClick={onClose} />}
      <div className={`sidebar ${open ? "sidebar-open" : ""}`}>
        <button className="new-chat-btn" onClick={onNewChat}>
          + New Chat
        </button>
        <div className="conversations-list">
          {conversations.map((conv) => (
            <button
              key={conv.id}
              className={`conv-item ${currentId === conv.id ? "conv-active" : ""}`}
              onClick={() => onSelectConversation(conv)}
            >
              {conv.title}
            </button>
          ))}
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
