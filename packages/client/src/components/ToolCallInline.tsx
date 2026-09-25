import { useState, useMemo } from "react";
import type { MessagePart } from "@thechat/shared";
import { formatToolSummary } from "../lib/tool-summary";
import type { BatchChildResult } from "../lib/batch";
import { useElapsedTime } from "../hooks/useElapsedTime";
import { TruncatedOutput } from "./TruncatedOutput";
import { DiffPreview } from "./DiffPreview";
import { WritePreview } from "./WritePreview";
import { Check, ChevronRight, LoaderCircle, X } from "lucide-react";

type ToolCallPart = Extract<MessagePart, { type: "tool-call" }>;
type ToolResultPart = Extract<MessagePart, { type: "tool-result" }>;

const PREVIEW_TOOLS = new Set(["edit", "multiedit", "write"]);

function batchChildSummary(tool: string, args: Record<string, unknown>): string {
  return formatToolSummary({
    type: "tool-call",
    toolCallId: "",
    toolName: tool,
    args,
  });
}

function ToolCallPreview({ call }: { call: ToolCallPart }) {
  const { toolName, args } = call;

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

function StatusIcon({ result }: { result?: ToolResultPart }) {
  if (!result) {
    return <LoaderCircle size={14} aria-hidden="true" className="shrink-0 animate-spin text-text-dimmed" />;
  }
  if (result.isError) {
    return <X size={14} aria-hidden="true" className="shrink-0 text-error-bright" />;
  }
  return <Check size={14} aria-hidden="true" className="shrink-0 text-success" />;
}

export function ToolCallInline({
  call,
  result,
  startTime,
}: {
  call: ToolCallPart;
  result?: ToolResultPart;
  startTime?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const summary = formatToolSummary(call);
  const hasPreview = PREVIEW_TOOLS.has(call.toolName);
  const hasResult = result && !hasPreview;
  const canExpand = hasPreview || hasResult;
  const elapsed = useElapsedTime(!result && startTime ? startTime : null);

  const childResults = useMemo(
    () => (result?.result as { results?: BatchChildResult[] } | null)?.results ?? null,
    [result],
  );

  if (call.toolName === "batch") {
    const toolCalls = Array.isArray(call.args.tool_calls)
      ? (call.args.tool_calls as { tool: string; args: Record<string, unknown> }[])
      : [];
    const isRunning = !result;

    return (
      <div className="py-1.5 px-0">
        <div className="flex items-center gap-2 text-[0.857rem] text-text-muted">
          <StatusIcon result={result} />
          <span className="min-w-0 flex-1 truncate">
            Batch: {toolCalls.length} operation{toolCalls.length !== 1 ? "s" : ""}
          </span>
          {elapsed && (
            <span className="shrink-0 tabular-nums text-[0.786rem] text-text-dimmed">
              {elapsed}
            </span>
          )}
        </div>
        {toolCalls.length > 0 && (
          <div className="mt-0.5">
            {toolCalls.map((tc, i) => {
              const cr = childResults?.[i];
              const childSummaryText = batchChildSummary(tc.tool, tc.args);
              return (
                <div key={i} className="flex items-center gap-2 py-0.5 pl-6 text-[0.857rem] text-text-muted">
                  {isRunning ? (
                    <LoaderCircle size={14} aria-hidden="true" className="shrink-0 animate-spin text-text-dimmed" />
                  ) : cr && !cr.success ? (
                    <X size={14} aria-hidden="true" className="shrink-0 text-error-bright" />
                  ) : (
                    <Check size={14} aria-hidden="true" className="shrink-0 text-success" />
                  )}
                  <span className="min-w-0 flex-1 truncate">{childSummaryText}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="py-1.5 px-0">
      <button
        type="button"
        className="flex w-full cursor-pointer items-center gap-2 border-none bg-transparent p-0 text-left text-[0.857rem] text-text-muted shadow-none transition-colors duration-150 hover:text-text-secondary"
        onClick={() => canExpand && setExpanded((v) => !v)}
        style={{ cursor: canExpand ? "pointer" : "default" }}
      >
        <StatusIcon result={result} />
        <span className="min-w-0 flex-1 truncate">{summary}</span>
        {elapsed && (
          <span className="shrink-0 tabular-nums text-[0.786rem] text-text-dimmed">
            {elapsed}
          </span>
        )}
        {canExpand && (
          <ChevronRight
            size={14}
            aria-hidden="true"
            className={`shrink-0 text-text-dimmed transition-transform duration-150 ${expanded ? "rotate-90" : ""}`}
          />
        )}
      </button>
      {expanded && (
        <div className="mt-1.5 pl-6">
          {hasPreview && <ToolCallPreview call={call} />}
          {hasResult && (
            <div className="rounded-lg border border-border-subtle bg-raised px-3 py-2">
              <TruncatedOutput
                text={typeof result.result === "string" ? result.result : JSON.stringify(result.result, null, 2)}
                isError={result.isError}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
