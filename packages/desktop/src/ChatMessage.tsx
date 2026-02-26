import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import type { Message, MessagePart, QuestionRequest } from "./core/types";
import type { PermissionRequest } from "./core/permission";
import { useStreamingParts } from "./stores/streaming";
import { TextWithUiBlocks } from "./components/TextWithUiBlocks";
import { ToolCallInline } from "./components/ToolCallInline";
import { DiffPreview } from "./components/DiffPreview";
import { WritePreview } from "./components/WritePreview";
type ToolCallPart = Extract<MessagePart, { type: "tool-call" }>;
type ToolResultPart = Extract<MessagePart, { type: "tool-result" }>;

const PREVIEW_TOOLS = new Set(["edit", "multiedit", "write"]);

interface ToolPreviewInfo {
  toolName: string;
  args: Record<string, unknown>;
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

// -- Streaming inline blocks --

type StreamBlock =
  | { type: "reasoning"; text: string; isActive: boolean; key: string }
  | { type: "tool-call"; call: ToolCallPart; result?: ToolResultPart; key: string }
  | { type: "text"; text: string; key: string };

function buildStreamBlocks(parts: MessagePart[]): StreamBlock[] {
  const resultMap = new Map<string, ToolResultPart>();
  for (const p of parts) {
    if (p.type === "tool-result") {
      resultMap.set(p.toolCallId, p as ToolResultPart);
    }
  }

  const blocks: StreamBlock[] = [];
  let i = 0;

  while (i < parts.length) {
    const part = parts[i];

    if (part.type === "reasoning") {
      const startIdx = i;
      let text = "";
      while (i < parts.length && parts[i].type === "reasoning") {
        text += (parts[i] as Extract<MessagePart, { type: "reasoning" }>).text;
        i++;
      }
      // Reasoning is "active" if nothing follows it yet
      const isActive = i >= parts.length;
      blocks.push({ type: "reasoning", text, isActive, key: `r-${startIdx}` });
    } else if (part.type === "tool-call") {
      const call = part as ToolCallPart;
      blocks.push({
        type: "tool-call",
        call,
        result: resultMap.get(call.toolCallId),
        key: `tc-${call.toolCallId}`,
      });
      i++;
    } else if (part.type === "text") {
      if (part.text !== "") {
        blocks.push({ type: "text", text: part.text, key: `t-${i}` });
      }
      i++;
    } else {
      // Skip tool-result parts (rendered via ToolCallInline)
      i++;
    }
  }

  return blocks;
}

function StreamingReasoningBlock({ text, isActive }: { text: string; isActive: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const wasActive = useRef(isActive);

  useEffect(() => {
    // Auto-collapse when reasoning finishes
    if (wasActive.current && !isActive) {
      setExpanded(false);
    }
    wasActive.current = isActive;
  }, [isActive]);

  const label = isActive ? "Thinking..." : "Thought for a moment";

  return (
    <div className="py-0.5">
      <button
        type="button"
        className="flex cursor-pointer items-center gap-1.5 border-none bg-none p-0 py-1 text-[12px] text-text-dimmed shadow-none transition-colors duration-150 hover:text-text-muted"
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="w-3 text-[10px]">{expanded ? "\u25BE" : "\u25B8"}</span>
        <span className={isActive ? "animate-pulse" : ""}>{label}</span>
      </button>
      {expanded && (
        <pre className="mt-1 max-h-[400px] overflow-y-auto overflow-x-auto whitespace-pre-wrap rounded-lg border-l-2 border-border-accent bg-raised px-3 py-2.5 font-[inherit] text-[13px] leading-relaxed text-text-secondary">
          {text}
        </pre>
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
    <div data-testid="permission-inline" className="my-2 rounded-lg border border-accent-border/40 bg-raised p-3">
      <div className="mb-2 text-[13px] font-medium text-text-secondary">{permissionHeader(toolArgs)}</div>
      <code className="mb-2 block whitespace-pre-wrap break-all rounded-lg border border-border bg-base px-3 py-2 font-mono text-[12.5px] text-text">{permission.command}</code>
      {toolArgs && <ToolInlinePreview toolName={toolArgs.toolName} args={toolArgs.args} />}
      {permission.description && !toolArgs && (
        <div className="mb-2.5 text-[12px] text-text-muted">{permission.description}</div>
      )}
      {feedbackVisible ? (
        <div className="flex items-center gap-2">
          <input
            ref={inputRef}
            className="flex-1 rounded-lg border border-border bg-base px-3 py-1.5 font-[inherit] text-[13px] text-text outline-none placeholder:text-text-placeholder focus:border-border-focus"
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
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border-none bg-button px-3.5 py-1.5 text-[13px] font-medium text-text shadow-none transition-colors duration-150 hover:bg-button-hover"
            disabled={feedbackText.trim().length === 0}
            onClick={handleSubmitFeedback}
          >
            Send
          </button>
        </div>
      ) : (
        <div className="flex justify-end gap-1.5">
          <button
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border-none bg-none px-3 py-1.5 text-[12px] font-medium text-text-muted shadow-none transition-colors duration-150 hover:bg-hover hover:text-text"
            onClick={onDeny}
          >
            Deny <kbd className="rounded border border-border bg-base px-1 py-px font-mono text-[10px] text-text-dimmed">C-x d</kbd>
          </button>
          {onDenyWithFeedback && (
            <button
              className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border-none bg-none px-3 py-1.5 text-[12px] font-medium text-text-muted shadow-none transition-colors duration-150 hover:bg-hover hover:text-text"
              onClick={() => setFeedbackVisible(true)}
            >
              Deny with feedback <kbd className="rounded border border-border bg-base px-1 py-px font-mono text-[10px] text-text-dimmed">C-x f</kbd>
            </button>
          )}
          <button
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border-none bg-accent/15 px-3.5 py-1.5 text-[12px] font-medium text-accent shadow-none transition-colors duration-150 hover:bg-accent/25"
            onClick={onAllow}
          >
            Allow <kbd className="rounded border border-accent/20 bg-accent/10 px-1 py-px font-mono text-[10px] text-accent/70">C-x a</kbd>
          </button>
        </div>
      )}
    </div>
  );
}

const CUSTOM = "__custom__";

interface QuestionPromptBlockProps {
  request: QuestionRequest;
  onSubmit: (answers: string[][]) => void;
  onCancel: () => void;
}

export function QuestionPromptBlock({ request, onSubmit, onCancel }: QuestionPromptBlockProps) {
  const [selections, setSelections] = useState<string[][]>(
    request.questions.map(() => []),
  );
  const [customText, setCustomText] = useState<string[]>(
    request.questions.map(() => ""),
  );
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);

  const toggleOption = useCallback((qIndex: number, value: string) => {
    setSelections((prev) => {
      const updated = [...prev];
      const current = updated[qIndex] ?? [];
      const isMultiple = request.questions[qIndex]?.multiple;

      if (isMultiple) {
        updated[qIndex] = current.includes(value)
          ? current.filter((v) => v !== value)
          : [...current, value];
      } else {
        updated[qIndex] = current[0] === value ? [] : [value];
      }
      return updated;
    });
  }, [request.questions]);

  const activateCustom = useCallback((qIndex: number) => {
    const isMultiple = request.questions[qIndex]?.multiple;
    setSelections((prev) => {
      const updated = [...prev];
      const current = updated[qIndex] ?? [];
      if (isMultiple) {
        if (!current.includes(CUSTOM)) {
          updated[qIndex] = [...current, CUSTOM];
        }
      } else {
        updated[qIndex] = [CUSTOM];
      }
      return updated;
    });
  }, [request.questions]);

  const handleSubmit = useCallback(() => {
    const final = selections.map((sel, i) => {
      return sel
        .map((v) => (v === CUSTOM ? customText[i]?.trim() ?? "" : v))
        .filter(Boolean);
    });
    onSubmit(final);
  }, [selections, customText, onSubmit]);

  return (
    <div className="my-2 rounded-lg border border-accent-secondary/30 bg-raised p-3">
      {request.questions.map((q, qIndex) => {
        const current = selections[qIndex] ?? [];
        const customActive = current.includes(CUSTOM);

        return (
          <div key={qIndex} className="mb-3 last:mb-2.5">
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-text-dimmed">{q.header}</div>
            <div className="mb-2 text-[13px] text-text">{q.question}</div>
            <div className="flex flex-col gap-1">
              {q.options.map((opt) => (
                <button
                  key={opt.label}
                  className={`flex cursor-pointer flex-col rounded-lg border px-3 py-2 text-left font-[inherit] shadow-none transition-all duration-150 ${current.includes(opt.label) ? "border-accent-secondary/50 bg-accent-secondary/8" : "border-border bg-base hover:border-border-strong hover:bg-hover"}`}
                  onClick={() => toggleOption(qIndex, opt.label)}
                >
                  <span className="text-[13px] font-medium text-text">{opt.label}</span>
                  <span className="mt-0.5 text-[12px] text-text-muted">{opt.description}</span>
                </button>
              ))}
              <div
                data-testid="question-option-custom"
                className={`flex cursor-pointer flex-row items-center rounded-lg border px-3 py-2 text-left font-[inherit] shadow-none transition-all duration-150 ${customActive ? "border-accent-secondary/50 bg-accent-secondary/8" : "border-border bg-base hover:border-border-strong hover:bg-hover"}`}
                onClick={() => {
                  toggleOption(qIndex, CUSTOM);
                  if (!customActive) {
                    inputRefs.current[qIndex]?.focus();
                  }
                }}
              >
                <input
                  ref={(el) => { inputRefs.current[qIndex] = el; }}
                  type="text"
                  placeholder="Type your own answer..."
                  className="w-full border-none bg-transparent p-0 font-[inherit] text-[13px] text-text outline-none placeholder:text-text-placeholder"
                  value={customText[qIndex] ?? ""}
                  onClick={(e) => e.stopPropagation()}
                  onFocus={() => activateCustom(qIndex)}
                  onChange={(e) => {
                    const value = e.target.value;
                    setCustomText((prev) => {
                      const updated = [...prev];
                      updated[qIndex] = value;
                      return updated;
                    });
                    activateCustom(qIndex);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      handleSubmit();
                    }
                  }}
                />
              </div>
            </div>
          </div>
        );
      })}
      <div className="flex justify-end gap-1.5">
        <button className="cursor-pointer rounded-lg border-none bg-none px-3.5 py-1.5 text-[12px] font-medium text-text-muted shadow-none transition-colors duration-150 hover:bg-hover hover:text-text" onClick={onCancel}>
          Cancel
        </button>
        <button className="cursor-pointer rounded-lg border-none bg-button px-3.5 py-1.5 text-[12px] font-medium text-text shadow-none transition-colors duration-150 hover:bg-button-hover" onClick={handleSubmit}>
          Submit
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
  const blocks = useMemo(() => buildStreamBlocks(message.parts), [message.parts]);

  return (
    <div data-testid={`chat-message-${isUser ? "user" : "assistant"}`} className="w-full px-5 py-4">
      <div className={`mb-1.5 text-[11px] font-semibold uppercase tracking-wider ${isUser ? "text-text-dimmed" : "text-accent/80"}`}>
        {isUser ? "You" : "Assistant"}
      </div>
      <div className="max-w-3xl">
        {blocks.map((block) => {
          switch (block.type) {
            case "reasoning":
              return (
                <StreamingReasoningBlock
                  key={block.key}
                  text={block.text}
                  isActive={false}
                />
              );
            case "tool-call":
              return (
                <ToolCallInline
                  key={block.key}
                  call={block.call}
                  result={block.result}
                />
              );
            case "text":
              return <TextWithUiBlocks key={block.key} text={block.text} />;
          }
        })}
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
  pendingQuestion?: QuestionRequest | null;
  onQuestionSubmit?: (answers: string[][]) => void;
  onQuestionCancel?: () => void;
}

export function StreamingMessage({ convId, pendingPermission, onPermissionAllow, onPermissionDeny, onPermissionDenyWithFeedback, showFeedbackInput, pendingQuestion, onQuestionSubmit, onQuestionCancel }: StreamingMessageProps) {
  const parts = useStreamingParts(convId);
  const promptRef = useRef<HTMLDivElement>(null);

  // Scroll to permission/question prompts when they appear (user needs to interact)
  useEffect(() => {
    if (pendingPermission || pendingQuestion) {
      promptRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [pendingPermission, pendingQuestion]);

  if (!parts) return null;

  const blocks = buildStreamBlocks(parts);
  const hasContent = blocks.length > 0;

  // Still need flat tool lists for permission prompt matching
  const toolCalls = parts.filter((p): p is ToolCallPart => p.type === "tool-call");
  const toolResults = parts.filter((p): p is ToolResultPart => p.type === "tool-result");

  return (
    <>
      <div data-testid="chat-message-assistant" className="w-full px-5 py-4">
        <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-accent/80">Assistant</div>
        <div className="max-w-3xl">
          {blocks.map((block, idx) => {
            switch (block.type) {
              case "reasoning":
                return (
                  <StreamingReasoningBlock
                    key={block.key}
                    text={block.text}
                    isActive={block.isActive}
                  />
                );
              case "tool-call":
                return (
                  <ToolCallInline
                    key={block.key}
                    call={block.call}
                    result={block.result}
                  />
                );
              case "text": {
                const isLastText = idx === blocks.length - 1 && !pendingPermission && !pendingQuestion;
                return isLastText ? (
                  <div key={block.key} className="streaming-cursor">
                    <TextWithUiBlocks text={block.text} />
                  </div>
                ) : (
                  <TextWithUiBlocks key={block.key} text={block.text} />
                );
              }
            }
          })}
          <div ref={promptRef}>
            {pendingPermission && onPermissionAllow && onPermissionDeny && (
              <PermissionPromptBlock
                permission={pendingPermission}
                onAllow={onPermissionAllow}
                onDeny={onPermissionDeny}
                onDenyWithFeedback={onPermissionDenyWithFeedback}
                showFeedbackInput={showFeedbackInput}
                toolArgs={(() => {
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
            {pendingQuestion && onQuestionSubmit && onQuestionCancel && (
              <QuestionPromptBlock
                request={pendingQuestion}
                onSubmit={onQuestionSubmit}
                onCancel={onQuestionCancel}
              />
            )}
          </div>
          {!pendingPermission && !pendingQuestion && !hasContent && (
            <div data-testid="typing-indicator" className="flex items-center gap-1 text-text-dimmed">
              <span className="inline-block size-1.5 animate-pulse rounded-full bg-text-dimmed" />
              <span className="inline-block size-1.5 animate-pulse rounded-full bg-text-dimmed" style={{ animationDelay: "0.2s" }} />
              <span className="inline-block size-1.5 animate-pulse rounded-full bg-text-dimmed" style={{ animationDelay: "0.4s" }} />
            </div>
          )}
        </div>
      </div>
    </>
  );
}
