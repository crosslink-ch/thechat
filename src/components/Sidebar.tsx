import type { Conversation } from "../core/types";

interface SidebarProps {
  open: boolean;
  conversations: Conversation[];
  currentId: string | undefined;
  onClose: () => void;
  onNewChat: () => void;
  onSelectConversation: (conv: Conversation) => void;
}

export function Sidebar({
  open,
  conversations,
  currentId,
  onClose,
  onNewChat,
  onSelectConversation,
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
      </div>
    </>
  );
}
