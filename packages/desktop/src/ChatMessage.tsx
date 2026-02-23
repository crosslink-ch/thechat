import { useState, useEffect, useRef, useMemo } from "react";
import type { Message, MessagePart } from "./core/types";
import type { PermissionRequest } from "./core/permission";
import { useStreamingParts } from "./stores/streaming";
import { TextWithUiBlocks } from "./components/TextWithUiBlocks";
import { DiffPreview } from "./components/DiffPreview";
import { WritePreview } from "./components/WritePreview";
import { basename } from "./lib/path";

type ToolCallPart = Extract<MessagePart, { type: "tool-call" }>;
type ToolResultPart = Extract<MessagePart, { type: "tool-result" }>;

const PREVIEW_TOOLS = new Set(["edit", "multiedit", "write"]);

function getFilePath(call: ToolCallPart): string | undefined {
  const fp = call.args.file_path;
  return typeof fp === "string" ? fp : undefined;
}

interface ToolPreviewInfo {
  toolName: string;
  args: Record<string, unknown>;
}

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

function ToolInlinePreview({ toolName, args }: ToolPreviewInfo) {
  if (toolName === "edit") {
    const oldStr = typeof args.old_string === "string" ? args.old_string : "";
    const newStr = typeof args.new_string === "string" ? args.new_string : "";
    if (!oldStr && !newStr) return null;
    return <DiffPreview oldStr={oldStr} newStr={newStr} />;
  }

  if (toolName === "multiedit") {
    const edits = Array.isArray(args.edits) ? args.edits : [];
    if (edits.length === 0) return null;
    return (
      <>
        {edits.map((edit: Record<string, unknown>, i: number) => {
          const oldStr = typeof edit.old_string === "string" ? edit.old_string : "";
          const newStr = typeof edit.new_string === "string" ? edit.new_string : "";
          return (
            <DiffPreview
              key={i}
              oldStr={oldStr}
              newStr={newStr}
              label={`Edit ${i + 1} of ${edits.length}`}
            />
          );
        })}
      </>
    );
  }

  if (toolName === "write") {
    const content = typeof args.content === "string" ? args.content : "";
    if (!content) return null;
    return <WritePreview content={content} />;
  }

  return null;
}

function ToolActivityBlock({
  call,
  result,
}: {
  call: ToolCallPart;
  result?: ToolResultPart;
}) {
  const [open, setOpen] = useState(false);
  const filePath = getFilePath(call);
  const [fileName, setFileName] = useState<string | null>(null);

  useEffect(() => {
    if (filePath) {
      basename(filePath).then(setFileName);
    }
  }, [filePath]);

  const status = !result ? "Running..." : result.isError ? "Error" : "Done";
  const statusClass = result?.isError ? "tool-status-error" : "";
  const hasPreview = PREVIEW_TOOLS.has(call.toolName);

  return (
    <div className="tool-activity">
      <button className="tool-activity-toggle" onClick={() => setOpen(!open)}>
        <span className="tool-activity-chevron">{open ? "▾" : "▸"}</span>
        <span className="tool-activity-name">{call.toolName}</span>
        {fileName && <span className="tool-activity-path">{fileName}</span>}
        <span className={`tool-activity-status ${statusClass}`}>{status}</span>
      </button>
      {hasPreview && (
        <div className="tool-activity-preview">
          <ToolInlinePreview toolName={call.toolName} args={call.args} />
        </div>
      )}
      {open && (
        <div className="tool-activity-details">
          {!hasPreview && Object.keys(call.args).length > 0 && (
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
  const resultMap = useMemo(
    () => new Map(toolResults.map((r) => [r.toolCallId, r])),
    [toolResults],
  );

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

function permissionHeader(toolArgs?: ToolPreviewInfo): string {
  if (!toolArgs) return "Run command?";
  if (toolArgs.toolName === "write") return "Write file?";
  if (toolArgs.toolName === "edit" || toolArgs.toolName === "multiedit") return "Edit file?";
  return "Run command?";
}

function PermissionPromptBlock({
  permission,
  onAllow,
  onDeny,
  onDenyWithFeedback,
  showFeedbackInput,
  toolArgs,
}: {
  permission: PermissionRequest;
  onAllow: () => void;
  onDeny: () => void;
  onDenyWithFeedback?: (feedback: string) => void;
  showFeedbackInput?: boolean;
  toolArgs?: ToolPreviewInfo;
}) {
  const [feedbackVisible, setFeedbackVisible] = useState(showFeedbackInput ?? false);
  const [feedbackText, setFeedbackText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // Sync with external showFeedbackInput prop (from keyboard shortcut)
  useEffect(() => {
    if (showFeedbackInput) setFeedbackVisible(true);
  }, [showFeedbackInput]);

  // Auto-focus input when it appears
  useEffect(() => {
    if (feedbackVisible) inputRef.current?.focus();
  }, [feedbackVisible]);

  const handleSubmitFeedback = () => {
    const trimmed = feedbackText.trim();
    if (!trimmed || !onDenyWithFeedback) return;
    onDenyWithFeedback(trimmed);
  };

  return (
    <div className="permission-inline">
      <div className="permission-inline-header">{permissionHeader(toolArgs)}</div>
      <code className="permission-inline-command">{permission.command}</code>
      {toolArgs && <ToolInlinePreview toolName={toolArgs.toolName} args={toolArgs.args} />}
      {permission.description && !toolArgs && (
        <div className="permission-inline-desc">{permission.description}</div>
      )}
      {feedbackVisible ? (
        <div className="permission-feedback-input">
          <input
            ref={inputRef}
            className="permission-feedback-field"
            type="text"
            placeholder="Feedback for AI..."
            value={feedbackText}
            onChange={(e) => setFeedbackText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                handleSubmitFeedback();
              } else if (e.key === "Escape") {
                e.preventDefault();
                setFeedbackVisible(false);
                setFeedbackText("");
              }
            }}
          />
          <button
            className="permission-inline-btn permission-inline-allow"
            disabled={feedbackText.trim().length === 0}
            onClick={handleSubmitFeedback}
          >
            Send
          </button>
        </div>
      ) : (
        <div className="permission-inline-actions">
          <button className="permission-inline-btn permission-inline-deny" onClick={onDeny}>
            Deny <kbd>C-x d</kbd>
          </button>
          {onDenyWithFeedback && (
            <button
              className="permission-inline-btn permission-inline-feedback"
              onClick={() => setFeedbackVisible(true)}
            >
              Deny with feedback <kbd>C-x f</kbd>
            </button>
          )}
          <button className="permission-inline-btn permission-inline-allow" onClick={onAllow}>
            Allow <kbd>C-x a</kbd>
          </button>
        </div>
      )}
    </div>
  );
}

interface ChatMessageProps {
  message: Message;
}

export function ChatMessage({ message }: ChatMessageProps) {
  const isUser = message.role === "user";

  const { reasoningText, toolCalls, toolResults, textParts } = useMemo(() => {
    const reasoning = message.parts.filter((p) => p.type === "reasoning");
    return {
      reasoningText: reasoning.map((p) => p.text).join(""),
      toolCalls: message.parts.filter((p): p is ToolCallPart => p.type === "tool-call"),
      toolResults: message.parts.filter((p): p is ToolResultPart => p.type === "tool-result"),
      textParts: message.parts.filter((p): p is Extract<MessagePart, { type: "text" }> => p.type === "text"),
    };
  }, [message.parts]);
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
          <TextWithUiBlocks key={i} text={part.text} />
        ))}
      </div>
    </div>
  );
}

interface StreamingMessageProps {
  convId: string | undefined;
  pendingPermission?: PermissionRequest | null;
  onPermissionAllow?: () => void;
  onPermissionDeny?: () => void;
  onPermissionDenyWithFeedback?: (feedback: string) => void;
  showFeedbackInput?: boolean;
}

export function StreamingMessage({ convId, pendingPermission, onPermissionAllow, onPermissionDeny, onPermissionDenyWithFeedback, showFeedbackInput }: StreamingMessageProps) {
  const parts = useStreamingParts(convId);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollIntoView?.({ behavior: "smooth" });
  }, [parts]);

  if (!parts) return null;

  const reasoningParts = parts.filter((p) => p.type === "reasoning");
  const reasoningText = reasoningParts.map((p) => p.text).join("");
  const toolCalls = parts.filter((p): p is ToolCallPart => p.type === "tool-call");
  const toolResults = parts.filter((p): p is ToolResultPart => p.type === "tool-result");
  const textParts = parts.filter((p): p is Extract<MessagePart, { type: "text" }> => p.type === "text" && p.text !== "");
  const hasThinking = reasoningText.length > 0 || toolCalls.length > 0;
  const hasContent = textParts.length > 0;

  return (
    <>
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
            <TextWithUiBlocks key={i} text={part.text} />
          ))}
          {pendingPermission && onPermissionAllow && onPermissionDeny && (
            <PermissionPromptBlock
              permission={pendingPermission}
              onAllow={onPermissionAllow}
              onDeny={onPermissionDeny}
              onDenyWithFeedback={onPermissionDenyWithFeedback}
              showFeedbackInput={showFeedbackInput}
              toolArgs={(() => {
                // Match permission command prefix to the last unresolved tool call
                const cmd = pendingPermission.command;
                for (const name of PREVIEW_TOOLS) {
                  if (cmd.startsWith(name + " ")) {
                    const pending = [...toolCalls].reverse().find(
                      (tc) => tc.toolName === name && !toolResults.some((tr) => tr.toolCallId === tc.toolCallId),
                    );
                    if (pending) return { toolName: pending.toolName, args: pending.args };
                  }
                }
                return undefined;
              })()}
            />
          )}
          {!pendingPermission && !hasContent && !hasThinking && (
            <div className="message-text typing-indicator">...</div>
          )}
        </div>
      </div>
      <div ref={scrollRef} />
    </>
  );
}
