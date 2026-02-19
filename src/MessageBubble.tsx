import { useState } from "react";
import type { Message, MessagePart } from "./core/types";

interface MessageBubbleProps {
  message: Message;
}

function ToolCallBlock({ part }: { part: Extract<MessagePart, { type: "tool-call" }> }) {
  return (
    <div className="tool-call-block">
      <div className="tool-call-header">Tool Call: {part.toolName}</div>
      <pre className="tool-call-args">{JSON.stringify(part.args, null, 2)}</pre>
    </div>
  );
}

function ToolResultBlock({ part }: { part: Extract<MessagePart, { type: "tool-result" }> }) {
  return (
    <div className={`tool-result-block ${part.isError ? "tool-result-error" : ""}`}>
      <div className="tool-result-header">
        {part.isError ? "Error" : "Result"}: {part.toolName}
      </div>
      <pre className="tool-result-content">
        {typeof part.result === "string" ? part.result : JSON.stringify(part.result, null, 2)}
      </pre>
    </div>
  );
}

export function MessageBubble({ message }: MessageBubbleProps) {
  const [reasoningOpen, setReasoningOpen] = useState(false);
  const isUser = message.role === "user";

  const reasoningParts = message.parts.filter((p) => p.type === "reasoning");
  const hasReasoning = !isUser && reasoningParts.length > 0;
  const reasoningText = reasoningParts.map((p) => p.text).join("");

  return (
    <div className={`message ${isUser ? "message-user" : "message-assistant"}`}>
      {hasReasoning && (
        <div className="reasoning-block">
          <button
            className="reasoning-toggle"
            onClick={() => setReasoningOpen(!reasoningOpen)}
          >
            {reasoningOpen ? "Hide" : "Show"} Thinking
          </button>
          {reasoningOpen && <pre className="reasoning-content">{reasoningText}</pre>}
        </div>
      )}
      {message.parts.map((part, i) => {
        switch (part.type) {
          case "text":
            return (
              <div key={i} className="message-content">
                {part.text}
              </div>
            );
          case "tool-call":
            return <ToolCallBlock key={i} part={part} />;
          case "tool-result":
            return <ToolResultBlock key={i} part={part} />;
          case "reasoning":
            return null; // Rendered in the toggle above
        }
      })}
    </div>
  );
}

interface StreamingBubbleProps {
  parts: MessagePart[];
}

export function StreamingBubble({ parts }: StreamingBubbleProps) {
  const [reasoningOpen, setReasoningOpen] = useState(true);

  const reasoningParts = parts.filter((p) => p.type === "reasoning");
  const hasReasoning = reasoningParts.length > 0;
  const reasoningText = reasoningParts.map((p) => p.text).join("");
  const contentParts = parts.filter((p) => p.type !== "reasoning");
  const hasContent = contentParts.some(
    (p) => (p.type === "text" && p.text) || p.type === "tool-call" || p.type === "tool-result",
  );

  return (
    <div className="message message-assistant">
      {hasReasoning && (
        <div className="reasoning-block reasoning-active">
          <button
            className="reasoning-toggle"
            onClick={() => setReasoningOpen(!reasoningOpen)}
          >
            {reasoningOpen ? "Hide" : "Show"} Thinking
            {!hasContent && <span className="thinking-indicator"> ...</span>}
          </button>
          {reasoningOpen && <pre className="reasoning-content">{reasoningText}</pre>}
        </div>
      )}
      {contentParts.map((part, i) => {
        switch (part.type) {
          case "text":
            return part.text ? (
              <div key={i} className="message-content">
                {part.text}
              </div>
            ) : null;
          case "tool-call":
            return <ToolCallBlock key={i} part={part} />;
          case "tool-result":
            return <ToolResultBlock key={i} part={part} />;
          default:
            return null;
        }
      })}
      {!hasContent && !hasReasoning && (
        <div className="message-content typing-indicator">...</div>
      )}
    </div>
  );
}
