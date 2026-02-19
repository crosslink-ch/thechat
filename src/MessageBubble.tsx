import { useState } from "react";
import type { Message } from "./types";

interface MessageBubbleProps {
  message: Message;
}

export function MessageBubble({ message }: MessageBubbleProps) {
  const [reasoningOpen, setReasoningOpen] = useState(false);
  const isUser = message.role === "user";

  return (
    <div className={`message ${isUser ? "message-user" : "message-assistant"}`}>
      {!isUser && message.reasoning_content && (
        <div className="reasoning-block">
          <button
            className="reasoning-toggle"
            onClick={() => setReasoningOpen(!reasoningOpen)}
          >
            {reasoningOpen ? "Hide" : "Show"} Thinking
          </button>
          {reasoningOpen && (
            <pre className="reasoning-content">{message.reasoning_content}</pre>
          )}
        </div>
      )}
      <div className="message-content">{message.content}</div>
    </div>
  );
}

interface StreamingBubbleProps {
  content: string;
  reasoning: string;
}

export function StreamingBubble({ content, reasoning }: StreamingBubbleProps) {
  const [reasoningOpen, setReasoningOpen] = useState(true);

  return (
    <div className="message message-assistant">
      {reasoning && (
        <div className="reasoning-block reasoning-active">
          <button
            className="reasoning-toggle"
            onClick={() => setReasoningOpen(!reasoningOpen)}
          >
            {reasoningOpen ? "Hide" : "Show"} Thinking
            {!content && <span className="thinking-indicator"> ...</span>}
          </button>
          {reasoningOpen && (
            <pre className="reasoning-content">{reasoning}</pre>
          )}
        </div>
      )}
      {content ? (
        <div className="message-content">{content}</div>
      ) : (
        !reasoning && <div className="message-content typing-indicator">...</div>
      )}
    </div>
  );
}
