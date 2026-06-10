import { useEffect, useState } from "react";
import type {
  BotInvocationProgressEventPublic,
  BotInvocationPublic,
  MessagePart,
} from "@thechat/shared";
import type { ActiveHermesInvocationProgress } from "../lib/hermes-progress";
import {
  approvalCommandForDecision,
  approvalDecisionLabel,
  deriveApprovalStates,
  isApprovalRequestEvent,
  isApprovalResolutionEvent,
  type ApprovalDecision,
  type ApprovalRequestState,
} from "../lib/hermes-approvals";
import {
  recordApprovalDecision,
  useHermesApprovalsStore,
} from "../stores/hermes-approvals";
import { formatToolSummary } from "../lib/tool-summary";

type ToolCallPart = Extract<MessagePart, { type: "tool-call" }>;
type NoticeSeverity = "info" | "warning" | "error";

/**
 * One visual row in the activity timeline. Rows are built by walking the
 * invocation's events in sequence order, so the list reflects the actual
 * order things happened: a tool row sits where the tool started (its
 * completion only updates it in place), a thinking row sits where that
 * reasoning block began (consecutive reasoning events collapse into it),
 * and an approval sits where Hermes asked — pending or resolved.
 */
type EventRow = {
  kind: "tool" | "notice" | "reasoning" | "other";
  key: string;
  event: BotInvocationProgressEventPublic;
};
type ApprovalRow = { kind: "approval"; key: string; state: ApprovalRequestState };
type ActivityRow = EventRow | ApprovalRow;

const MAX_VISIBLE_ROWS = 8;

export function HermesProgressInline({
  invocations,
  onApprovalCommand,
}: {
  invocations: ActiveHermesInvocationProgress[];
  onApprovalCommand?: (command: string) => void;
}) {
  const decisions = useHermesApprovalsStore((state) => state.decisions);
  const nowMs = useNowTick(invocations.length > 0);
  const [expandedRowKeys, setExpandedRowKeys] = useState<Set<string>>(
    () => new Set(),
  );

  if (invocations.length === 0) return null;

  const toggleRow = (key: string) => {
    setExpandedRowKeys((previous) => {
      const next = new Set(previous);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  };

  const approvalStatesByInvocation = new Map(
    invocations.map(({ invocation, events }) => [
      invocation.id,
      deriveApprovalStates(events, decisions),
    ]),
  );
  // The gateway resolves approvals oldest-first across the whole session, so
  // only the globally oldest pending request gets active buttons.
  const actionableApprovalId =
    [...approvalStatesByInvocation.values()]
      .flat()
      .filter((state) => state.status === "pending")
      .sort(
        (a, b) => Date.parse(a.event.createdAt) - Date.parse(b.event.createdAt),
      )[0]?.event.id ?? null;

  const handleApprovalDecision = (
    event: BotInvocationProgressEventPublic,
    decision: ApprovalDecision,
  ) => {
    // The command flows through the regular send pipeline, where the DM route
    // records the optimistic decision for the oldest pending approval — the
    // same event this button targets. Recording here afterwards is a no-op in
    // that case and a fallback for consumers that don't record.
    onApprovalCommand?.(approvalCommandForDecision(decision));
    recordApprovalDecision(event.id, decision);
  };

  return (
    <div className="space-y-2 px-5 py-2">
      {invocations.map(({ invocation, events }) => {
        const invocationEvents = [...events].sort(compareEvents);
        const approvalStates =
          approvalStatesByInvocation.get(invocation.id) ?? [];
        const needsApproval = approvalStates.some(
          (state) => state.status === "pending",
        );
        const rows = buildActivityRows(invocationEvents, approvalStates);
        let visibleRows = rows.slice(-MAX_VISIBLE_ROWS);
        // Pending approvals must stay actionable even when older than the
        // visible window (e.g. parallel tools kept emitting afterwards).
        const hiddenPending = rows.filter(
          (row) =>
            row.kind === "approval" &&
            row.state.status === "pending" &&
            !visibleRows.includes(row),
        );
        visibleRows = [...hiddenPending, ...visibleRows];
        const hiddenCount = rows.length - visibleRows.length;
        const elapsedLabel = invocation.startedAt
          ? formatElapsed(nowMs - Date.parse(invocation.startedAt))
          : null;

        return (
          <div key={invocation.id} className="flex gap-2.5">
            <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-elevated text-[0.857rem] font-semibold text-text-muted">
              {invocation.botName.charAt(0).toUpperCase()}
            </div>
            <div
              className={`min-w-0 flex-1 rounded-md border px-3 py-2 ${
                needsApproval
                  ? "border-warning-text/30 bg-raised/40"
                  : "border-border-subtle bg-raised/40"
              }`}
            >
              <div className="mb-1.5 flex items-center gap-2">
                <span
                  className={`inline-block size-2 shrink-0 rounded-full ${
                    needsApproval
                      ? "bg-warning-text"
                      : "animate-pulse bg-accent"
                  }`}
                />
                <span className="min-w-0 flex-1 truncate text-[0.857rem] font-medium text-text-muted">
                  {invocation.botName}{" "}
                  {needsApproval
                    ? "is waiting for your approval"
                    : invocation.status === "queued"
                    ? "is queued"
                    : "is working"}
                  {elapsedLabel && (
                    <span className="text-text-dimmed"> · {elapsedLabel}</span>
                  )}
                </span>
                {needsApproval ? (
                  <span className="shrink-0 rounded border border-warning-text/40 bg-warning-bg px-1.5 py-0.5 text-[0.643rem] font-medium uppercase text-warning-text">
                    action needed
                  </span>
                ) : (
                  <span className="shrink-0 rounded border border-accent/40 bg-accent/10 px-1.5 py-0.5 text-[0.643rem] font-medium uppercase text-accent">
                    {invocation.status}
                  </span>
                )}
              </div>

              {hiddenCount > 0 && (
                <div className="pb-1 pl-4 text-[0.714rem] text-text-dimmed">
                  {hiddenCount} earlier update{hiddenCount === 1 ? "" : "s"}
                </div>
              )}

              {visibleRows.length > 0 ? (
                <div className="space-y-1.5">
                  {visibleRows.map((row) => (
                    <div
                      key={row.key}
                      data-testid="hermes-activity-row"
                      data-kind={rowKind(row)}
                    >
                      {row.kind === "approval" ? (
                        row.state.status === "pending" ? (
                          <ApprovalRequestCard
                            event={row.state.event}
                            botName={invocation.botName}
                            isActionable={
                              row.state.event.id === actionableApprovalId
                            }
                            onDecision={(decision) =>
                              handleApprovalDecision(row.state.event, decision)
                            }
                          />
                        ) : (
                          <ResolvedApprovalRow
                            state={row.state}
                            expanded={expandedRowKeys.has(row.key)}
                            onToggle={() => toggleRow(row.key)}
                          />
                        )
                      ) : row.kind === "notice" ? (
                        <NoticeEventRow event={row.event} />
                      ) : row.kind === "reasoning" ? (
                        <ReasoningEventRow
                          event={row.event}
                          expanded={expandedRowKeys.has(row.key)}
                          onToggle={() => toggleRow(row.key)}
                        />
                      ) : row.kind === "tool" ? (
                        <ToolEventRow
                          event={row.event}
                          expanded={expandedRowKeys.has(row.key)}
                          onToggle={() => toggleRow(row.key)}
                        />
                      ) : (
                        <OtherEventRow event={row.event} />
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="pl-4 text-[0.786rem] text-text-dimmed">
                  {emptyStateLabel(invocation, nowMs)}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Ticks every second while active so elapsed-time labels stay current. */
function useNowTick(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [active]);
  return now;
}

function buildActivityRows(
  sortedEvents: BotInvocationProgressEventPublic[],
  approvalStates: ApprovalRequestState[],
): ActivityRow[] {
  const approvalStateByEventId = new Map(
    approvalStates.map((state) => [state.event.id, state]),
  );
  const rows: ActivityRow[] = [];
  const toolRowByCallId = new Map<string, EventRow>();

  for (const event of sortedEvents) {
    if (isApprovalRequestEvent(event)) {
      const state = approvalStateByEventId.get(event.id);
      if (state) rows.push({ kind: "approval", key: event.id, state });
      continue;
    }
    if (isApprovalResolutionEvent(event)) continue; // consumed by deriveApprovalStates

    if (isNoticeEvent(event)) {
      rows.push({ kind: "notice", key: event.id, event });
      continue;
    }

    if (isReasoningEvent(event)) {
      // Consecutive reasoning events are one thinking block: update the row
      // in place (latest text) without moving it in the timeline.
      const lastRow = rows[rows.length - 1];
      if (lastRow?.kind === "reasoning") {
        lastRow.event = event;
      } else {
        rows.push({ kind: "reasoning", key: event.id, event });
      }
      continue;
    }

    if (isToolEvent(event)) {
      const callId = event.toolCallId;
      const existing = callId ? toolRowByCallId.get(callId) : undefined;
      if (!existing) {
        const row: EventRow = {
          kind: "tool",
          key: callId ? `tool:${callId}` : event.id,
          event,
        };
        rows.push(row);
        if (callId) toolRowByCallId.set(callId, row);
        continue;
      }
      // Lifecycle updates (completed/failed) refresh status, duration, and
      // missing text but keep the row at its start position.
      existing.event = {
        ...event,
        label: existing.event.label?.trim() ? existing.event.label : event.label,
        preview: existing.event.preview?.trim()
          ? existing.event.preview
          : event.preview,
      };
      continue;
    }

    rows.push({ kind: "other", key: event.id, event });
  }

  return rows;
}

function rowKind(row: ActivityRow) {
  if (row.kind === "approval") {
    return row.state.status === "pending" ? "approval-pending" : "approval-resolved";
  }
  return row.kind;
}

function isToolEvent(event: BotInvocationProgressEventPublic) {
  if (event.type.startsWith("tool.")) return true;
  return Boolean(event.toolCallId && event.toolName && !event.toolName.startsWith("_"));
}

function isNoticeEvent(event: BotInvocationProgressEventPublic) {
  return event.type.startsWith("notice.") || event.type.startsWith("status.");
}

function isReasoningEvent(event: BotInvocationProgressEventPublic) {
  return (
    event.type.startsWith("reasoning.") ||
    event.type === "_thinking" ||
    event.toolName === "_thinking"
  );
}

function emptyStateLabel(invocation: BotInvocationPublic, nowMs: number) {
  if (invocation.status === "queued") return "Queued";
  if (invocation.status === "running" && olderThan(invocation.startedAt, 30_000, nowMs)) {
    return "No recent Hermes activity";
  }
  return "Waiting for the next Hermes update";
}

function olderThan(iso: string | null, ageMs: number, nowMs: number) {
  if (!iso) return false;
  return nowMs - Date.parse(iso) > ageMs;
}

function ToolEventRow({
  event,
  expanded,
  onToggle,
}: {
  event: BotInvocationProgressEventPublic;
  expanded: boolean;
  onToggle: () => void;
}) {
  const status = event.status ?? statusFromType(event.type);
  const payload = event.payload ?? {};
  const duration = typeof payload.duration === "number" ? payload.duration : null;

  return (
    <div className="min-w-0">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        className="flex w-full min-w-0 cursor-pointer items-center gap-2 text-left text-[0.786rem] text-text-muted hover:text-text"
      >
        <StatusDot status={status} />
        {event.toolName && (
          <span
            className="max-w-[10rem] shrink-0 truncate rounded border border-border bg-base px-1.5 py-0.5 font-mono text-[0.714rem] text-text-dimmed"
            title={event.toolName}
          >
            {event.toolName}
          </span>
        )}
        <span className="min-w-0 flex-1 truncate">{eventLabel(event)}</span>
        {duration !== null && (
          <span className="shrink-0 tabular-nums text-text-dimmed">
            {formatDuration(duration)}
          </span>
        )}
        <ExpandChevron expanded={expanded} />
      </button>
      {expanded && (
        <code
          data-testid="hermes-activity-detail"
          className="mt-1 block whitespace-pre-wrap break-all rounded border border-border bg-base px-2 py-1.5 font-mono text-[0.714rem] leading-relaxed text-text-secondary"
        >
          {toolDetailText(event)}
        </code>
      )}
    </div>
  );
}

function NoticeEventRow({ event }: { event: BotInvocationProgressEventPublic }) {
  const severity = noticeSeverity(event);
  const style =
    severity === "error"
      ? "border-error/30 bg-error/10 text-error"
      : severity === "warning"
      ? "border-warning-text/30 bg-warning-bg text-warning-text"
      : "border-accent/25 bg-accent/10 text-text-secondary";
  const badge = severity === "warning" ? "warn" : severity;

  return (
    <div className={`rounded border px-2 py-1.5 text-[0.786rem] ${style}`}>
      <div className="flex min-w-0 items-start gap-2">
        <span className="mt-0.5 shrink-0 rounded border border-current/30 px-1.5 py-0.5 text-[0.643rem] font-medium uppercase">
          {badge}
        </span>
        <span className="min-w-0 whitespace-pre-wrap break-words leading-relaxed">
          {eventText(event)}
        </span>
      </div>
    </div>
  );
}

function ReasoningEventRow({
  event,
  expanded,
  onToggle,
}: {
  event: BotInvocationProgressEventPublic;
  expanded: boolean;
  onToggle: () => void;
}) {
  const fullText = eventText(event);
  const previewText = firstLine(fullText);

  return (
    <div className="rounded border border-border-subtle bg-base/40 px-2 py-1.5 text-[0.786rem]">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        className="flex w-full min-w-0 cursor-pointer items-start gap-2 text-left"
      >
        <span className="mt-1.5 inline-block size-1.5 shrink-0 animate-pulse rounded-full bg-accent" />
        <span className="min-w-0 flex-1">
          <span className="block font-medium text-text-muted">Thinking</span>
          {!expanded && previewText && (
            <span className="block truncate text-text-dimmed">{previewText}</span>
          )}
        </span>
        <ExpandChevron expanded={expanded} className="mt-0.5" />
      </button>
      {expanded && fullText && (
        <div
          data-testid="hermes-activity-detail"
          className="mt-1 whitespace-pre-wrap break-words pl-3.5 leading-relaxed text-text-dimmed"
        >
          {fullText}
        </div>
      )}
    </div>
  );
}

function ApprovalRequestCard({
  event,
  botName,
  isActionable,
  onDecision,
}: {
  event: BotInvocationProgressEventPublic;
  botName: string;
  isActionable: boolean;
  onDecision: (decision: ApprovalDecision) => void;
}) {
  const command = approvalCommandText(event);
  const description = stringField(event.payload, "description");
  const choices = approvalChoices(event);

  return (
    <div
      data-testid="hermes-approval-request"
      className="rounded-md border border-warning-text/30 bg-warning-bg/70 px-3 py-2 text-[0.786rem] text-text-secondary"
    >
      <div className="mb-2 flex min-w-0 items-center gap-2">
        <span className="inline-block size-2 shrink-0 animate-pulse rounded-full bg-warning-text" />
        <div className="min-w-0 flex-1 font-medium text-text">
          {botName} wants to run a command
        </div>
      </div>

      {command && (
        <code className="mb-2 block max-h-40 overflow-y-auto whitespace-pre-wrap break-all rounded border border-border bg-base px-2 py-1.5 font-mono text-[0.714rem] text-text">
          {command}
        </code>
      )}

      {description && (
        <div className="mb-2 whitespace-pre-wrap break-words text-text-muted">
          {description}
        </div>
      )}

      {isActionable ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {choices.includes("once") && (
            <ApprovalButton
              label="Approve"
              tone="primary"
              onClick={() => onDecision("once")}
            />
          )}
          {choices.includes("session") && (
            <ApprovalButton
              label="Approve for session"
              tone="secondary"
              onClick={() => onDecision("session")}
            />
          )}
          {choices.includes("always") && (
            <ApprovalButton
              label="Always approve"
              tone="secondary"
              onClick={() => onDecision("always")}
            />
          )}
          {choices.includes("deny") && (
            <ApprovalButton
              label="Deny"
              tone="danger"
              className="ml-auto"
              onClick={() => onDecision("deny")}
            />
          )}
        </div>
      ) : (
        <div className="text-text-dimmed">
          Waiting for the earlier approval to be resolved first.
        </div>
      )}
    </div>
  );
}

function ResolvedApprovalRow({
  state,
  expanded,
  onToggle,
}: {
  state: ApprovalRequestState;
  expanded: boolean;
  onToggle: () => void;
}) {
  const command = approvalCommandText(state.event);
  const decision = state.decision ?? "once";
  const denied = decision === "deny";

  return (
    <div className="min-w-0" data-testid="hermes-approval-resolved">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        className="flex w-full min-w-0 cursor-pointer items-center gap-2 text-left text-[0.786rem] text-text-muted hover:text-text"
      >
        <span
          className={`inline-block size-2 shrink-0 rounded-full ${
            denied ? "bg-error" : "bg-success"
          }`}
        />
        <span
          className={`shrink-0 font-medium ${
            denied ? "text-error-light" : "text-success-light"
          }`}
        >
          {approvalDecisionLabel(decision)}
        </span>
        {command && (
          <code
            className="min-w-0 flex-1 truncate font-mono text-[0.714rem] text-text-dimmed"
            title={command}
          >
            {command}
          </code>
        )}
        <ExpandChevron expanded={expanded} />
      </button>
      {expanded && command && (
        <code
          data-testid="hermes-activity-detail"
          className="mt-1 block whitespace-pre-wrap break-all rounded border border-border bg-base px-2 py-1.5 font-mono text-[0.714rem] leading-relaxed text-text-secondary"
        >
          {command}
        </code>
      )}
    </div>
  );
}

function ApprovalButton({
  label,
  tone,
  className = "",
  onClick,
}: {
  label: string;
  tone: "primary" | "secondary" | "danger";
  className?: string;
  onClick: () => void;
}) {
  const toneClass =
    tone === "danger"
      ? "bg-error-bg text-error-bright hover:bg-danger-bg-hover"
      : tone === "primary"
      ? "bg-accent/15 text-accent hover:bg-accent/25"
      : "bg-button text-text-muted hover:bg-button-hover hover:text-text";

  return (
    <button
      type="button"
      className={`inline-flex min-h-7 cursor-pointer items-center rounded border border-border px-2.5 py-1 text-[0.786rem] font-medium transition-colors ${toneClass} ${className}`}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

function OtherEventRow({ event }: { event: BotInvocationProgressEventPublic }) {
  return (
    <div className="flex min-w-0 items-center gap-2 text-[0.786rem] text-text-dimmed">
      <span className="inline-block size-1.5 shrink-0 rounded-full bg-text-dimmed" />
      <span className="shrink-0 font-medium text-text-muted">Update</span>
      <span className="min-w-0 flex-1 truncate">{eventText(event)}</span>
    </div>
  );
}

function ExpandChevron({
  expanded,
  className = "",
}: {
  expanded: boolean;
  className?: string;
}) {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 10 10"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={`shrink-0 text-text-dimmed transition-transform duration-150 ${
        expanded ? "rotate-90" : ""
      } ${className}`}
    >
      <path d="M3.5 2l3 3-3 3" />
    </svg>
  );
}

function StatusDot({ status }: { status: string | null }) {
  if (status === "running") {
    return (
      <span
        className="inline-block size-3 shrink-0 rounded-full border-2 border-text-dimmed border-t-transparent"
        style={{ animation: "spin 1s linear infinite" }}
      />
    );
  }
  const color = status === "failed" ? "bg-error" : "bg-success";
  return <span className={`inline-block size-2 shrink-0 rounded-full ${color}`} />;
}

function eventLabel(event: BotInvocationProgressEventPublic) {
  if (event.label?.trim()) return event.label.trim();
  if (event.toolName) {
    const args = recordField(event.payload, "args");
    const call: ToolCallPart = {
      type: "tool-call",
      toolCallId: event.toolCallId ?? event.id,
      toolName: event.toolName,
      args,
    };
    return formatToolSummary(call);
  }
  if (event.preview?.trim()) return event.preview.trim();
  return event.type.replace(/\./g, " ");
}

/** Fullest available text for an expanded tool row. */
function toolDetailText(event: BotInvocationProgressEventPublic) {
  const candidates = [
    event.label?.trim() ?? "",
    event.preview?.trim() ?? "",
    stringField(recordField(event.payload, "args"), "command"),
    eventLabel(event),
  ];
  return candidates.reduce(
    (longest, candidate) =>
      candidate.length > longest.length ? candidate : longest,
    "",
  );
}

function eventText(event: BotInvocationProgressEventPublic) {
  if (event.label?.trim()) return event.label.trim();
  if (event.preview?.trim()) return event.preview.trim();
  const payloadText = stringField(event.payload, "text");
  if (payloadText) return payloadText;
  return event.type.replace(/\./g, " ");
}

function stringField(source: Record<string, unknown> | null, key: string) {
  const value = source?.[key];
  return typeof value === "string" ? value.trim() : "";
}

function approvalCommandText(event: BotInvocationProgressEventPublic) {
  return (
    stringField(event.payload, "command") ||
    event.preview?.trim() ||
    ""
  );
}

function approvalChoices(event: BotInvocationProgressEventPublic): ApprovalDecision[] {
  const value = event.payload?.choices;
  const choices = Array.isArray(value)
    ? value.filter(isApprovalDecision)
    : [];
  return choices.length > 0 ? choices : ["once", "session", "always", "deny"];
}

function isApprovalDecision(value: unknown): value is ApprovalDecision {
  return (
    value === "once" ||
    value === "session" ||
    value === "always" ||
    value === "deny"
  );
}

function firstLine(text: string) {
  return text.split(/\r?\n/).find((line) => line.trim())?.trim() ?? "";
}

function noticeSeverity(event: BotInvocationProgressEventPublic): NoticeSeverity {
  if (
    event.status === "failed" ||
    event.status === "error" ||
    event.type.endsWith(".error")
  ) {
    return "error";
  }
  if (
    event.status === "warning" ||
    event.status === "warn" ||
    event.type.endsWith(".warning") ||
    event.type.endsWith(".warn")
  ) {
    return "warning";
  }
  return "info";
}

function recordField(source: Record<string, unknown> | null, key: string) {
  const value = source?.[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function statusFromType(type: string) {
  if (type.endsWith(".completed")) return "completed";
  if (type.endsWith(".failed")) return "failed";
  return "running";
}

function formatDuration(seconds: number) {
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  return `${Math.round(seconds)}s`;
}

function formatElapsed(elapsedMs: number) {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes}m ${totalSeconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function compareEvents(
  a: BotInvocationProgressEventPublic,
  b: BotInvocationProgressEventPublic,
) {
  if (a.sequence !== b.sequence) return a.sequence - b.sequence;
  return Date.parse(a.createdAt) - Date.parse(b.createdAt);
}
