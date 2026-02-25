import { useRef, useEffect, useCallback } from "react";
import { InputBar } from "./InputBar";
import { Markdown } from "./Markdown";
import type { ChatMessage } from "@thechat/shared";
import type { MentionUser } from "./MentionList";

const noop = () => {};

interface ChannelChatViewProps {
  messages: ChatMessage[];
  loading: boolean;
  typingUsers: Map<string, string>; // userId -> userName
  onSend: (content: string) => void;
  mentions?: MentionUser[];
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
  mentions,
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
      <div className="flex flex-1 flex-col overflow-y-auto">
        {loading && (
          <div className="flex flex-1 flex-col items-center justify-center text-[14px] text-text-placeholder">Loading messages...</div>
        )}
        {!loading && messages.length === 0 && (
          <div className="flex flex-1 flex-col items-center justify-center text-[14px] text-text-placeholder">No messages yet. Start the conversation!</div>
        )}
        {messages.map((msg) => (
          <div key={msg.id} className="flex gap-2.5 px-5 py-2.5 transition-colors duration-100 hover:bg-raised/50">
            <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-elevated text-[12px] font-semibold text-text-muted">
              {msg.senderName.charAt(0).toUpperCase()}
            </div>
            <div className="min-w-0 flex-1">
              <div className="mb-0.5 flex items-baseline gap-2">
                <span className="text-[13px] font-semibold text-text">{msg.senderName}</span>
                <span className="text-[10px] text-text-dimmed">{formatTime(msg.createdAt)}</span>
              </div>
              <Markdown content={msg.content} />
            </div>
          </div>
        ))}
        {typingNames.length > 0 && (
          <div className="animate-pulse px-5 py-1 pb-2 text-[11px] text-text-dimmed">
            {typingNames.join(", ")} {typingNames.length === 1 ? "is" : "are"} typing...
          </div>
        )}
        <div ref={endRef} />
      </div>
      <InputBar convId={undefined} onSend={handleSend} onStop={noop} mentions={mentions} />
    </>
  );
}
