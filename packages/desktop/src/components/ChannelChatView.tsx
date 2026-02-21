import { useRef, useEffect, useCallback } from "react";
import { InputBar } from "./InputBar";
import type { ChatMessage } from "@thechat/shared";

interface ChannelChatViewProps {
  messages: ChatMessage[];
  loading: boolean;
  typingUsers: Map<string, string>; // userId -> userName
  onSend: (content: string) => void;
}

function formatTime(iso: string) {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function ChannelChatView({
  messages,
  loading,
  typingUsers,
  onSend,
}: ChannelChatViewProps) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, typingUsers]);

  const handleSend = useCallback(
    (content: string) => {
      onSend(content);
    },
    [onSend]
  );

  const typingNames = Array.from(typingUsers.values()).filter(Boolean);

  return (
    <>
      <div className="messages-area">
        {loading && (
          <div className="empty-state">Loading messages...</div>
        )}
        {!loading && messages.length === 0 && (
          <div className="empty-state">No messages yet. Start the conversation!</div>
        )}
        {messages.map((msg) => (
          <div key={msg.id} className="channel-message">
            <div className="channel-message-avatar">
              {msg.senderName.charAt(0).toUpperCase()}
            </div>
            <div className="channel-message-body">
              <div className="channel-message-header">
                <span className="channel-message-sender">{msg.senderName}</span>
                <span className="channel-message-time">{formatTime(msg.createdAt)}</span>
              </div>
              <div className="channel-message-text">{msg.content}</div>
            </div>
          </div>
        ))}
        {typingNames.length > 0 && (
          <div className="channel-typing">
            {typingNames.join(", ")} {typingNames.length === 1 ? "is" : "are"} typing...
          </div>
        )}
        <div ref={endRef} />
      </div>
      <InputBar convId={undefined} onSend={handleSend} onStop={() => {}} />
    </>
  );
}
