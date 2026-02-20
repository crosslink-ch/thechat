import { useState } from "react";
import type { Message, MessagePart } from "./core/types";
import type { PermissionRequest } from "./core/permission";

type ToolCallPart = Extract<MessagePart, { type: "tool-call" }>;
type ToolResultPart = Extract<MessagePart, { type: "tool-result" }>;

function formatArgs(args: Record<string, unknown>): string {
  const entries = Object.entries(args);
  if (entries.length === 0) return "";
  return entries.map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`).join(", ");
}

function formatResult(result: unknown): string {
  if (typeof result === "string") return result;
  const text = JSON.stringify(result, null, 2);
  return text.length > 500 ? text.slice(0, 500) + "..." : text;
}

function ToolActivityBlock({
  call,
  result,
}: {
  call: ToolCallPart;
  result?: ToolResultPart;
}) {
  const [open, setOpen] = useState(false);

  const status = !result ? "Running..." : result.isError ? "Error" : "Done";
  const statusClass = result?.isError ? "tool-status-error" : "";

  return (
    <div className="tool-activity">
      <button className="tool-activity-toggle" onClick={() => setOpen(!open)}>
        <span className="tool-activity-chevron">{open ? "▾" : "▸"}</span>
        <span className="tool-activity-name">{call.toolName}</span>
        <span className={`tool-activity-status ${statusClass}`}>{status}</span>
      </button>
      {open && (
        <div className="tool-activity-details">
          {Object.keys(call.args).length > 0 && (
            <div className="tool-detail-section">
              <div className="tool-detail-label">Args</div>
              <pre className="tool-detail-content">{formatArgs(call.args)}</pre>
            </div>
          )}
          {result && (
            <div className="tool-detail-section">
              <div className="tool-detail-label">{result.isError ? "Error" : "Result"}</div>
              <pre className="tool-detail-content">{formatResult(result.result)}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function buildThinkingLabel(hasReasoning: boolean, toolCount: number): string {
  if (hasReasoning && toolCount > 0) {
    return `Thought and used ${toolCount} tool${toolCount > 1 ? "s" : ""}`;
  }
  if (hasReasoning) return "Thought";
  return `Used ${toolCount} tool${toolCount > 1 ? "s" : ""}`;
}

function ThinkingSection({
  reasoningText,
  toolCalls,
  toolResults,
  defaultOpen,
  isStreaming,
}: {
  reasoningText: string;
  toolCalls: ToolCallPart[];
  toolResults: ToolResultPart[];
  defaultOpen: boolean;
  isStreaming?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  const hasReasoning = reasoningText.length > 0;
  const toolCount = toolCalls.length;
  if (!hasReasoning && toolCount === 0) return null;

  const label = buildThinkingLabel(hasReasoning, toolCount);
  const resultMap = new Map(toolResults.map((r) => [r.toolCallId, r]));

  return (
    <div className="thinking-section">
      <button className="thinking-toggle" onClick={() => setOpen(!open)}>
        <span className="thinking-chevron">{open ? "▾" : "▸"}</span>
        <span>{label}</span>
        {isStreaming && <span className="thinking-indicator"> ...</span>}
      </button>
      {open && (
        <div className="thinking-content">
          {hasReasoning && <pre className="reasoning-text">{reasoningText}</pre>}
          {toolCalls.map((call) => (
            <ToolActivityBlock
              key={call.toolCallId}
              call={call}
              result={resultMap.get(call.toolCallId)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function PermissionPromptBlock({
  permission,
  onAllow,
  onDeny,
}: {
  permission: PermissionRequest;
  onAllow: () => void;
  onDeny: () => void;
}) {
  return (
    <div className="permission-inline">
      <div className="permission-inline-header">Run command?</div>
      <code className="permission-inline-command">{permission.command}</code>
      {permission.description && (
        <div className="permission-inline-desc">{permission.description}</div>
      )}
      <div className="permission-inline-actions">
        <button className="permission-inline-btn permission-inline-deny" onClick={onDeny}>
          Deny <kbd>C-x d</kbd>
        </button>
        <button className="permission-inline-btn permission-inline-allow" onClick={onAllow}>
          Allow <kbd>C-x a</kbd>
        </button>
      </div>
    </div>
  );
}

interface ChatMessageProps {
  message: Message;
}

export function ChatMessage({ message }: ChatMessageProps) {
  const isUser = message.role === "user";

  const reasoningParts = message.parts.filter((p) => p.type === "reasoning");
  const reasoningText = reasoningParts.map((p) => p.text).join("");
  const toolCalls = message.parts.filter((p): p is ToolCallPart => p.type === "tool-call");
  const toolResults = message.parts.filter((p): p is ToolResultPart => p.type === "tool-result");
  const textParts = message.parts.filter((p): p is Extract<MessagePart, { type: "text" }> => p.type === "text");
  const hasThinking = !isUser && (reasoningText.length > 0 || toolCalls.length > 0);

  return (
    <div className={`chat-message ${isUser ? "chat-message-user" : "chat-message-assistant"}`}>
      <div className={`message-label ${isUser ? "label-user" : "label-ai"}`}>
        {isUser ? "You" : "AI"}
      </div>
      <div className="message-body">
        {hasThinking && (
          <ThinkingSection
            reasoningText={reasoningText}
            toolCalls={toolCalls}
            toolResults={toolResults}
            defaultOpen={false}
          />
        )}
        {textParts.map((part, i) => (
          <div key={i} className="message-text">
            {part.text}
          </div>
        ))}
      </div>
    </div>
  );
}

interface StreamingMessageProps {
  parts: MessagePart[];
  pendingPermission?: PermissionRequest | null;
  onPermissionAllow?: () => void;
  onPermissionDeny?: () => void;
}

export function StreamingMessage({ parts, pendingPermission, onPermissionAllow, onPermissionDeny }: StreamingMessageProps) {
  const reasoningParts = parts.filter((p) => p.type === "reasoning");
  const reasoningText = reasoningParts.map((p) => p.text).join("");
  const toolCalls = parts.filter((p): p is ToolCallPart => p.type === "tool-call");
  const toolResults = parts.filter((p): p is ToolResultPart => p.type === "tool-result");
  const textParts = parts.filter((p): p is Extract<MessagePart, { type: "text" }> => p.type === "text" && p.text !== "");
  const hasThinking = reasoningText.length > 0 || toolCalls.length > 0;
  const hasContent = textParts.length > 0;

  return (
    <div className="chat-message chat-message-assistant">
      <div className="message-label label-ai">AI</div>
      <div className="message-body">
        {hasThinking && (
          <ThinkingSection
            reasoningText={reasoningText}
            toolCalls={toolCalls}
            toolResults={toolResults}
            defaultOpen={true}
            isStreaming={true}
          />
        )}
        {textParts.map((part, i) => (
          <div key={i} className="message-text">
            {part.text}
          </div>
        ))}
        {pendingPermission && onPermissionAllow && onPermissionDeny && (
          <PermissionPromptBlock
            permission={pendingPermission}
            onAllow={onPermissionAllow}
            onDeny={onPermissionDeny}
          />
        )}
        {!pendingPermission && !hasContent && !hasThinking && (
          <div className="message-text typing-indicator">...</div>
        )}
      </div>
    </div>
  );
}
