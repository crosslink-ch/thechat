import { useState } from "react";
import type { MessagePart } from "@thechat/shared";
import { formatToolSummary } from "../lib/tool-summary";
import { TruncatedOutput } from "./TruncatedOutput";
import { DiffPreview } from "./DiffPreview";
import { WritePreview } from "./WritePreview";

type ToolCallPart = Extract<MessagePart, { type: "tool-call" }>;
type ToolResultPart = Extract<MessagePart, { type: "tool-result" }>;

const PREVIEW_TOOLS = new Set(["edit", "multiedit", "write"]);

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
    // Spinner: 12px border-based CSS spinner with animate-spin
    return (
      <span
        className="inline-block size-3 shrink-0 rounded-full border-2 border-text-dimmed border-t-transparent"
        style={{ animation: "spin 1s linear infinite" }}
      />
    );
  }
  if (result.isError) {
    return <span className="shrink-0 text-[12px] leading-none text-error">✕</span>;
  }
  return <span className="shrink-0 text-[12px] leading-none text-success">✓</span>;
}

export function ToolCallInline({
  call,
  result,
}: {
  call: ToolCallPart;
  result?: ToolResultPart;
}) {
  const [expanded, setExpanded] = useState(false);
  const summary = formatToolSummary(call);
  const hasPreview = PREVIEW_TOOLS.has(call.toolName);
  const hasResult = result && !hasPreview;
  const canExpand = hasPreview || hasResult;

  return (
    <div className="py-1.5 px-0">
      <button
        type="button"
        className="flex w-full cursor-pointer items-center gap-2 border-none bg-transparent p-0 text-left text-[12px] text-text-muted shadow-none hover:text-text-secondary"
        onClick={() => canExpand && setExpanded((v) => !v)}
        style={{ cursor: canExpand ? "pointer" : "default" }}
      >
        <StatusIcon result={result} />
        <span className="min-w-0 flex-1 truncate">{summary}</span>
        {canExpand && (
          <span className="shrink-0 text-[10px] text-text-dimmed">
            {expanded ? "▾" : "▸"}
          </span>
        )}
      </button>
      {expanded && (
        <div className="mt-1 pl-5">
          {hasPreview && <ToolCallPreview call={call} />}
          {hasResult && (
            <TruncatedOutput
              text={typeof result.result === "string" ? result.result : JSON.stringify(result.result, null, 2)}
              isError={result.isError}
            />
          )}
        </div>
      )}
    </div>
  );
}
