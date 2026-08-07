import { useEffect, useState } from "react";
import type {
  BotInvocationProgressEventPublic,
  BotInvocationPublic,
  MessagePart,
} from "@thechat/shared";
import type { ActiveHermesInvocationProgress } from "../lib/hermes-progress";
import {
  approvalDecisionLabel,
  deriveApprovalStates,
  isApprovalRequestEvent,
  isApprovalResolutionEvent,
  type ApprovalDecision,
  type ApprovalRequestState,
} from "../lib/hermes-approvals";
import {
  deriveClarifyStates,
  isClarifyRequestEvent,
  isClarifyResolutionEvent,
  type ClarifyRequestState,
  type ClarifyResponse,
} from "../lib/hermes-clarifications";
import {
  recordApprovalDecision,
  useHermesApprovalsStore,
} from "../stores/hermes-approvals";
import {
  recordClarifyResponse,
  useHermesClarificationsStore,
} from "../stores/hermes-clarifications";
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
type ClarifyRow = { kind: "clarify"; key: string; state: ClarifyRequestState };
type ActivityRow = EventRow | ApprovalRow | ClarifyRow;

const MAX_VISIBLE_ROWS = 8;
const MAX_UI_LABEL_CHARS = 4_000;
const MAX_UI_DESCRIPTION_CHARS = 10_000;
const MAX_UI_COMMAND_CHARS = 100_000;
const MAX_UI_DETAIL_CHARS = 20_000;
const MAX_UI_CHOICE_CHARS = 500;
const MAX_UI_CHOICES = 20;

export function HermesProgressInline({
  invocations,
  onInteraction,
  onStop,
}: {
  invocations: ActiveHermesInvocationProgress[];
  onInteraction?: (
    event: BotInvocationProgressEventPublic,
    response: string | string[],
  ) => void | Promise<void>;
  onStop?: () => void;
}) {
  const decisions = useHermesApprovalsStore((state) => state.decisions);
  const clarifyResponses = useHermesClarificationsStore(
    (state) => state.responses,
  );
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
  const clarifyStatesByInvocation = new Map(
    invocations.map(({ invocation, events }) => [
      invocation.id,
      deriveClarifyStates(events, clarifyResponses),
    ]),
  );
  // Approval ordering is scoped to the Hermes session. Independent sessions
  // may each expose their oldest pending request.
  const actionableApprovalIds = oldestPendingApprovalsBySession(
    [...approvalStatesByInvocation.values()].flat(),
  );

  const handleInteraction = async (
    event: BotInvocationProgressEventPublic,
    response: ApprovalDecision | ClarifyResponse,
  ) => {
    if (!onInteraction) {
      throw new Error("Hermes interactions are unavailable");
    }
    await onInteraction(event, response);
    // Persist optimistic state only after the callback was accepted. Gateway
    // resolution events remain authoritative and mark the row confirmed.
    if (event.type === "approval.request") {
      recordApprovalDecision(event.id, response as ApprovalDecision);
    } else {
      recordClarifyResponse(event.id, response);
    }
  };

  return (
    <div className="py-1">
      {invocations.map(({ invocation, events }) => {
        const invocationEvents = [...events].sort(compareEvents);
        const approvalStates =
          approvalStatesByInvocation.get(invocation.id) ?? [];
        const clarifyStates =
          clarifyStatesByInvocation.get(invocation.id) ?? [];
        const needsApproval = approvalStates.some(
          (state) => state.status === "pending",
        );
        const needsClarification = clarifyStates.some(
          (state) => state.status === "pending",
        );
        const needsInteraction = needsApproval || needsClarification;
        const rows = buildActivityRows(
          invocationEvents,
          approvalStates,
          clarifyStates,
        );
        let visibleRows = rows.slice(-MAX_VISIBLE_ROWS);
        // Pending approvals must stay actionable even when older than the
        // visible window (e.g. parallel tools kept emitting afterwards).
        const hiddenPending = rows.filter(
          (row) =>
            (row.kind === "approval" || row.kind === "clarify") &&
            row.state.status === "pending" &&
            !visibleRows.includes(row),
        );
        visibleRows = [...hiddenPending, ...visibleRows];
        const hiddenCount = rows.length - visibleRows.length;
        const elapsedLabel = invocation.startedAt
          ? formatElapsed(nowMs - Date.parse(invocation.startedAt))
          : null;
        const statusLabel = needsInteraction
          ? "action needed"
          : invocation.status === "queued"
            ? "queued"
            : "active";
        const title = needsApproval
          ? "is waiting for your approval"
          : needsClarification
            ? "is waiting for your response"
          : invocation.status === "queued"
            ? "is queued"
            : "is working";

        return (
          <div
            key={invocation.id}
            className="flex gap-2.5 px-5 py-2.5 transition-colors duration-100 hover:bg-raised/30"
          >
            <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-elevated text-[0.857rem] font-semibold text-text-muted">
              {invocation.botName.charAt(0).toUpperCase()}
            </div>
            <div className="min-w-0 flex-1">
              <div className="mb-2 flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
                <span className="min-w-0 text-[0.929rem] font-medium text-text-secondary">
                  {invocation.botName} {title}
                </span>
                <span
                  className={`inline-block size-1.5 shrink-0 rounded-full ${
                    needsInteraction
                      ? "bg-warning-text"
                      : "animate-pulse bg-[#54894a]"
                  }`}
                />
                <span
                  className={`shrink-0 rounded-sm px-1.5 py-0.5 text-[0.714rem] font-medium ${
                    needsInteraction
                      ? "bg-warning-bg text-warning-text"
                      : "bg-[#54894a]/10 text-[#8fcf84]"
                  }`}
                >
                  {statusLabel}
                </span>
                <div className="ml-auto flex shrink-0 items-center gap-2">
                  {elapsedLabel && (
                    <span className="tabular-nums text-[0.786rem] text-text-dimmed">
                      {elapsedLabel}
                    </span>
                  )}
                  {onStop && invocation.status !== "queued" && (
                    <button
                      type="button"
                      className="flex cursor-pointer items-center gap-1.5 rounded border border-border bg-transparent px-2 py-1 text-[0.786rem] font-medium text-text-muted transition-colors hover:bg-hover hover:text-text"
                      onClick={onStop}
                    >
                      <span className="size-2.5 rounded-sm border border-current bg-current" />
                      Stop
                    </button>
                  )}
                </div>
              </div>

              <div className="min-w-0">
                {hiddenCount > 0 && (
                  <div className="mb-3 flex items-center gap-2 text-[0.857rem] text-text-dimmed">
                    <span className="inline-block size-[13px] rounded-full border border-border bg-base" />
                    {hiddenCount} earlier update{hiddenCount === 1 ? "" : "s"}
                  </div>
                )}

                {visibleRows.length > 0 ? (
                  <div className="relative space-y-3.5 before:absolute before:bottom-[8px] before:left-[6px] before:top-[8px] before:w-px before:bg-border-subtle">
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
                              isActionable={actionableApprovalIds.has(
                                row.state.event.id,
                              )}
                              onDecision={(decision) =>
                                handleInteraction(row.state.event, decision)
                              }
                            />
                          ) : (
                            <ResolvedApprovalRow
                              state={row.state}
                              expanded={expandedRowKeys.has(row.key)}
                              onToggle={() => toggleRow(row.key)}
                            />
                          )
                        ) : row.kind === "clarify" ? (
                          row.state.status === "pending" ? (
                            <ClarifyRequestCard
                              state={row.state}
                              botName={invocation.botName}
                              onResponse={(response) =>
                                handleInteraction(row.state.event, response)
                              }
                            />
                          ) : (
                            <ResolvedClarifyRow state={row.state} />
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
                  <div className="text-[0.929rem] text-text-dimmed">
                    {emptyStateLabel(invocation, nowMs)}
                  </div>
                )}
              </div>
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
  clarifyStates: ClarifyRequestState[],
): ActivityRow[] {
  const approvalStateByEventId = new Map(
    approvalStates.map((state) => [state.event.id, state]),
  );
  const clarifyStateByEventId = new Map(
    clarifyStates.map((state) => [state.event.id, state]),
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
    if (isClarifyRequestEvent(event)) {
      const state = clarifyStateByEventId.get(event.id);
      if (state) {
        rows.push({ kind: "clarify", key: clarifyRowKey(state.event), state });
      }
      continue;
    }
    if (isClarifyResolutionEvent(event)) continue;

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
  if (row.kind === "clarify") {
    return row.state.status === "pending" ? "clarify-pending" : "clarify-resolved";
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
    <div className="relative z-10 min-w-0">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        className="flex w-full min-w-0 cursor-pointer items-start gap-2.5 text-left text-[0.929rem] text-text-muted transition-colors hover:text-text-secondary"
      >
        <StatusDot status={status} />
        {event.toolName && (
          <span
            className="max-w-[10rem] shrink-0 truncate rounded-sm border border-border bg-base/70 px-1.5 py-0.5 font-mono text-[0.786rem] text-text-dimmed"
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
          className="ml-6 mt-1.5 block max-h-72 overflow-y-auto whitespace-pre-wrap break-all border-l border-border-accent bg-raised/30 py-1.5 pl-3 pr-2 font-mono text-[0.786rem] leading-relaxed text-text-secondary"
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
      ? "border-error/60 text-error-light"
      : severity === "warning"
      ? "border-warning-text/70 text-warning-text"
      : "border-accent/50 text-text-muted";
  const badge = severity === "warning" ? "warn" : severity;

  return (
    <div className="relative z-10 flex min-w-0 items-start gap-2.5">
      <TimelineDot
        tone={
          severity === "error"
            ? "error"
            : severity === "warning"
              ? "warning"
              : "blue"
        }
      />
      <div
        className={`min-w-0 flex-1 border-l py-1 pl-3 text-[0.929rem] ${style}`}
      >
        <div className="flex min-w-0 items-start gap-2">
          <span className="mt-0.5 shrink-0 rounded-sm border border-current/30 bg-base/30 px-1.5 py-0.5 text-[0.643rem] font-medium uppercase">
            {badge}
          </span>
          <span className="min-w-0 whitespace-pre-wrap break-words leading-relaxed">
            {eventText(event)}
          </span>
        </div>
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
    <div className="relative z-10 flex min-w-0 items-start gap-2.5">
      <TimelineDot tone="blue" pulse />
      <div className="min-w-0 flex-1 text-[0.929rem]">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={onToggle}
          className="flex w-full min-w-0 cursor-pointer items-start gap-2 text-left text-text-muted transition-colors hover:text-text-secondary"
        >
          <span className="min-w-0 flex-1">
            <span className="block font-medium text-text-secondary">Thinking</span>
            {!expanded && previewText && (
              <span className="block truncate text-text-dimmed">
                {previewText}
              </span>
            )}
          </span>
          <ExpandChevron expanded={expanded} className="mt-0.5" />
        </button>
        {expanded && fullText && (
          <div
            data-testid="hermes-activity-detail"
            className="mt-1.5 whitespace-pre-wrap break-words border-l border-border-accent bg-raised/30 py-1.5 pl-3 pr-2 leading-relaxed text-text-dimmed"
          >
            {fullText}
          </div>
        )}
      </div>
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
  onDecision: (decision: ApprovalDecision) => void | Promise<void>;
}) {
  const command = approvalCommandText(event);
  const description = boundedUiText(
    stringField(event.payload, "description"),
    MAX_UI_DESCRIPTION_CHARS,
  );
  const choices = approvalChoices(event);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (decision: ApprovalDecision) => {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await onDecision(decision);
    } catch (cause) {
      setError(interactionErrorMessage(cause));
      setSubmitting(false);
    }
  };

  return (
    <div className="relative z-10 flex min-w-0 items-start gap-2.5">
      <TimelineDot tone="warning" pulse />
      <div
        data-testid="hermes-approval-request"
        className="min-w-0 flex-1 border-l-2 border-warning-text bg-warning-bg/35 py-2 pl-3 pr-2.5 text-[0.929rem] text-text-secondary"
      >
        <div className="mb-2 flex min-w-0 items-center gap-2">
          <div className="min-w-0 flex-1 font-medium text-text">
            {botName} wants to run a command
          </div>
        </div>

        {command && (
          <code className="mb-2 block max-h-40 overflow-y-auto whitespace-pre-wrap break-all border-l border-warning-text/40 bg-base/60 py-1.5 pl-3 pr-2 font-mono text-[0.714rem] text-text">
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
                disabled={submitting}
                onClick={() => void submit("once")}
              />
            )}
            {choices.includes("session") && (
              <ApprovalButton
                label="Approve for session"
                tone="secondary"
                disabled={submitting}
                onClick={() => void submit("session")}
              />
            )}
            {choices.includes("always") && (
              <ApprovalButton
                label="Always approve"
                tone="secondary"
                disabled={submitting}
                onClick={() => void submit("always")}
              />
            )}
            {choices.includes("deny") && (
              <ApprovalButton
                label="Deny"
                tone="danger"
                disabled={submitting}
                onClick={() => void submit("deny")}
              />
            )}
          </div>
        ) : (
          <div className="text-text-dimmed">
            Waiting for the earlier approval to be resolved first.
          </div>
        )}
        {submitting && (
          <div role="status" className="mt-2 text-[0.786rem] text-text-dimmed">
            Sending response…
          </div>
        )}
        {error && (
          <div
            role="alert"
            className="mt-2 text-[0.786rem] text-error-light"
          >
            {error}
          </div>
        )}
      </div>
    </div>
  );
}

function ClarifyRequestCard({
  state,
  botName,
  onResponse,
}: {
  state: ClarifyRequestState;
  botName: string;
  onResponse: (response: ClarifyResponse) => void | Promise<void>;
}) {
  const event = state.event;
  const question = boundedUiText(
    stringField(event.payload, "question") || eventText(event),
    MAX_UI_DETAIL_CHARS,
  );
  const choices = clarifyChoices(event);
  const multiSelect = event.payload?.multiSelect === true;
  const [selected, setSelected] = useState<string[]>([]);
  const [showOther, setShowOther] = useState(choices === null);
  const [customAnswer, setCustomAnswer] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (response: ClarifyResponse) => {
    if (submitting) return;
    const normalized =
      typeof response === "string" ? response.trim() : response;
    if (
      (typeof normalized === "string" && !normalized) ||
      (Array.isArray(normalized) && normalized.length === 0)
    ) {
      setError("Enter or select a response.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await onResponse(normalized);
    } catch (cause) {
      setError(interactionErrorMessage(cause));
      setSubmitting(false);
    }
  };

  const toggleChoice = (choice: string) => {
    setSelected((previous) =>
      previous.includes(choice)
        ? previous.filter((item) => item !== choice)
        : [...previous, choice],
    );
    setError(null);
  };

  const customField = (
    <div className="mt-2">
      <label
        htmlFor={`clarify-other-${event.id}`}
        className="sr-only"
      >
        {choices === null ? "Your response" : "Other response"}
      </label>
      <div className="flex min-w-0 flex-col gap-1.5 sm:flex-row sm:items-end">
        <textarea
          id={`clarify-other-${event.id}`}
          aria-label={choices === null ? "Your response" : "Other response"}
          rows={choices === null ? 2 : 1}
          maxLength={4_000}
          value={customAnswer}
          disabled={submitting}
          onChange={(event) => {
            setCustomAnswer(event.target.value);
            setError(null);
          }}
          onKeyDown={(keyboardEvent) => {
            if (
              keyboardEvent.key === "Enter" &&
              !keyboardEvent.shiftKey &&
              !keyboardEvent.nativeEvent.isComposing
            ) {
              keyboardEvent.preventDefault();
              void submit(customAnswer);
            }
          }}
          placeholder={choices === null ? "Type your response" : "Type another answer"}
          className="min-h-9 min-w-0 flex-1 resize-y rounded border border-border bg-base px-2.5 py-2 text-[0.857rem] text-text outline-none placeholder:text-text-placeholder focus:border-accent disabled:opacity-60"
        />
        <ApprovalButton
          label="Submit"
          tone="primary"
          disabled={submitting || customAnswer.trim().length === 0}
          onClick={() => void submit(customAnswer)}
        />
      </div>
      <div className="mt-1 text-[0.714rem] text-text-dimmed">
        Enter to submit · Shift+Enter for a new line
      </div>
    </div>
  );

  return (
    <div className="relative z-10 flex min-w-0 items-start gap-2.5">
      <TimelineDot tone="warning" pulse />
      <div
        data-testid="hermes-clarify-request"
        className="min-w-0 flex-1 border-l-2 border-warning-text bg-warning-bg/25 py-2 pl-3 pr-2.5 text-[0.929rem] text-text-secondary"
      >
        <div className="text-[0.786rem] font-medium text-warning-text">
          {botName} needs your input
        </div>
        <div className="mt-1 whitespace-pre-wrap break-words font-medium text-text">
          {question}
        </div>

        {choices && !multiSelect && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {choices.map((choice) => (
              <ApprovalButton
                key={choice}
                label={choice}
                tone="secondary"
                disabled={submitting}
                onClick={() => void submit(choice)}
              />
            ))}
            <ApprovalButton
              label={showOther ? "Hide other" : "Other"}
              tone="secondary"
              disabled={submitting}
              onClick={() => {
                setShowOther((visible) => !visible);
                setError(null);
              }}
            />
          </div>
        )}

        {choices && multiSelect && (
          <fieldset className="mt-2 min-w-0" disabled={submitting}>
            <legend className="sr-only">Select one or more answers</legend>
            <div className="flex flex-wrap gap-1.5">
              {choices.map((choice) => (
                <label
                  key={choice}
                  className="inline-flex min-h-8 cursor-pointer items-center gap-2 rounded border border-border bg-button/70 px-2.5 py-1 text-[0.786rem] text-text-muted hover:bg-button-hover has-[:checked]:border-accent/60 has-[:checked]:bg-accent/15 has-[:checked]:text-accent"
                >
                  <input
                    type="checkbox"
                    checked={selected.includes(choice)}
                    onChange={() => toggleChoice(choice)}
                    className="size-3.5 accent-accent"
                  />
                  <span className="break-words">{choice}</span>
                </label>
              ))}
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <ApprovalButton
                label="Submit selected"
                tone="primary"
                disabled={submitting || selected.length === 0}
                onClick={() => void submit(selected)}
              />
              <ApprovalButton
                label={showOther ? "Hide custom answer" : "Custom answer"}
                tone="secondary"
                disabled={submitting}
                onClick={() => {
                  setShowOther((visible) => !visible);
                  setError(null);
                }}
              />
            </div>
          </fieldset>
        )}

        {showOther && customField}
        {submitting && (
          <div role="status" className="mt-2 text-[0.786rem] text-text-dimmed">
            Sending response…
          </div>
        )}
        {error && (
          <div role="alert" className="mt-2 text-[0.786rem] text-error-light">
            {error}
          </div>
        )}
      </div>
    </div>
  );
}

function ResolvedClarifyRow({ state }: { state: ClarifyRequestState }) {
  const summary = clarifyResponseSummary(state.response);
  return (
    <div
      className="relative z-10 flex min-w-0 items-start gap-2.5 text-[0.929rem]"
      data-testid="hermes-clarify-resolved"
      data-confirmed={state.confirmed ? "true" : "false"}
    >
      <TimelineDot tone="success" />
      <span className="shrink-0 font-medium text-success-light">Answered</span>
      <span className="min-w-0 flex-1 truncate text-text-dimmed" title={summary}>
        {summary}
      </span>
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
    <div
      className="relative z-10 min-w-0"
      data-testid="hermes-approval-resolved"
      data-confirmed={state.confirmed ? "true" : "false"}
    >
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        className="flex w-full min-w-0 cursor-pointer items-start gap-2.5 text-left text-[0.929rem] text-text-secondary hover:text-text"
      >
        <TimelineDot tone={denied ? "error" : "success"} />
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
          className="ml-6 mt-1.5 block max-h-72 overflow-y-auto whitespace-pre-wrap break-all border-l border-border-accent bg-raised/30 py-1.5 pl-3 pr-2 font-mono text-[0.786rem] leading-relaxed text-text-secondary"
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
  disabled = false,
  onClick,
}: {
  label: string;
  tone: "primary" | "secondary" | "danger";
  className?: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  const toneClass =
    tone === "danger"
      ? "bg-error-bg/80 text-error-bright hover:bg-danger-bg-hover"
      : tone === "primary"
      ? "bg-accent/15 text-accent hover:bg-accent/25"
      : "bg-button/80 text-text-muted hover:bg-button-hover hover:text-text";

  return (
    <button
      type="button"
      disabled={disabled}
      className={`inline-flex min-h-7 cursor-pointer items-center rounded border border-border px-2.5 py-1 text-[0.786rem] font-medium transition-colors disabled:cursor-default disabled:opacity-55 ${toneClass} ${className}`}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

function OtherEventRow({ event }: { event: BotInvocationProgressEventPublic }) {
  return (
    <div className="relative z-10 flex min-w-0 items-start gap-2.5 text-[0.929rem] text-text-dimmed">
      <TimelineDot tone="muted" />
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

function TimelineDot({
  tone,
  pulse = false,
  className = "",
}: {
  tone: "blue" | "green" | "success" | "warning" | "error" | "muted";
  pulse?: boolean;
  className?: string;
}) {
  const colors =
    tone === "blue"
      ? {
          outer: "border-accent/50",
          inner: "bg-accent",
        }
      : tone === "green"
      ? {
          outer: "border-[rgba(84,137,74,0.5)]",
          inner: "bg-[#54894a]",
        }
      : tone === "success"
        ? {
            outer: "border-success/50",
            inner: "bg-success",
          }
        : tone === "warning"
          ? {
              outer: "border-warning-text/50",
              inner: "bg-warning-text",
            }
          : tone === "error"
            ? {
                outer: "border-error/50",
                inner: "bg-error",
              }
            : {
                outer: "border-text-dimmed/50",
                inner: "bg-text-dimmed",
              };

  return (
    <span
      className={`mt-1 flex size-[13px] shrink-0 items-center justify-center rounded-full border bg-base ${colors.outer} ${className}`}
    >
      <span
        className={`size-[5px] rounded-full ${colors.inner} ${
          pulse ? "animate-pulse" : ""
        }`}
      />
    </span>
  );
}

function StatusDot({ status }: { status: string | null }) {
  if (status === "running") return <TimelineDot tone="green" pulse />;
  if (status === "failed") return <TimelineDot tone="error" />;
  return <TimelineDot tone="success" />;
}

function eventLabel(event: BotInvocationProgressEventPublic) {
  if (event.label?.trim()) {
    return boundedUiText(event.label.trim(), MAX_UI_LABEL_CHARS);
  }
  if (event.toolName) {
    const args = recordField(event.payload, "args");
    const call: ToolCallPart = {
      type: "tool-call",
      toolCallId: event.toolCallId ?? event.id,
      toolName: event.toolName,
      args,
    };
    return boundedUiText(formatToolSummary(call), MAX_UI_LABEL_CHARS);
  }
  if (event.preview?.trim()) {
    return boundedUiText(event.preview.trim(), MAX_UI_LABEL_CHARS);
  }
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
  return boundedUiText(
    candidates.reduce(
      (longest, candidate) =>
        candidate.length > longest.length ? candidate : longest,
      "",
    ),
    MAX_UI_DETAIL_CHARS,
  );
}

function eventText(event: BotInvocationProgressEventPublic) {
  if (event.label?.trim()) {
    return boundedUiText(event.label.trim(), MAX_UI_LABEL_CHARS);
  }
  if (event.preview?.trim()) {
    return boundedUiText(event.preview.trim(), MAX_UI_LABEL_CHARS);
  }
  const payloadText = stringField(event.payload, "text");
  if (payloadText) return boundedUiText(payloadText, MAX_UI_DETAIL_CHARS);
  return event.type.replace(/\./g, " ");
}

function stringField(source: Record<string, unknown> | null, key: string) {
  const value = source?.[key];
  return typeof value === "string" ? value.trim() : "";
}

function approvalCommandText(event: BotInvocationProgressEventPublic) {
  return boundedUiText(
    stringField(event.payload, "command") ||
      event.preview?.trim() ||
      "",
    MAX_UI_COMMAND_CHARS,
  );
}

function approvalChoices(event: BotInvocationProgressEventPublic): ApprovalDecision[] {
  const value = event.payload?.choices;
  const choices = Array.isArray(value)
    ? [...new Set(value.slice(0, 4).filter(isApprovalDecision))]
    : [];
  return choices.length > 0 ? choices : ["once", "session", "always", "deny"];
}

function clarifyChoices(
  event: BotInvocationProgressEventPublic,
): string[] | null {
  const value = event.payload?.choices;
  if (value === null) return null;
  if (!Array.isArray(value)) return null;
  const choices = value
    .slice(0, MAX_UI_CHOICES)
    .filter(
      (choice): choice is string =>
        typeof choice === "string" &&
        choice.trim().length > 0 &&
        choice.length <= MAX_UI_CHOICE_CHARS,
    );
  return choices.length > 0 ? choices : null;
}

function clarifyRowKey(event: BotInvocationProgressEventPublic) {
  const requestId = stringField(event.payload, "requestId");
  return requestId ? `clarify:${requestId}` : `clarify:${event.id}`;
}

function clarifyResponseSummary(response: ClarifyResponse | null) {
  if (Array.isArray(response)) {
    return boundedUiText(
      response
        .slice(0, MAX_UI_CHOICES)
        .map((item) => boundedUiText(item, MAX_UI_CHOICE_CHARS))
        .join(", "),
      MAX_UI_LABEL_CHARS,
    );
  }
  if (response?.trim()) {
    return boundedUiText(response.trim(), MAX_UI_LABEL_CHARS);
  }
  return "Response recorded";
}

function boundedUiText(value: string, maxChars: number) {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

function interactionErrorMessage(cause: unknown) {
  return cause instanceof Error && cause.message.trim()
    ? cause.message
    : "Could not send the response. Try again.";
}

function oldestPendingApprovalsBySession(states: ApprovalRequestState[]) {
  const oldestBySession = new Map<string, ApprovalRequestState>();
  for (const state of states) {
    if (state.status !== "pending") continue;
    const sessionKey =
      state.event.botId +
      ":" +
      (stringField(state.event.payload, "sessionKey") || "__legacy__");
    const existing = oldestBySession.get(sessionKey);
    if (
      !existing ||
      compareInteractionRequestAge(state.event, existing.event) < 0
    ) {
      oldestBySession.set(sessionKey, state);
    }
  }
  return new Set(
    Array.from(oldestBySession.values()).map((state) => state.event.id),
  );
}

function compareInteractionRequestAge(
  left: BotInvocationProgressEventPublic,
  right: BotInvocationProgressEventPublic,
) {
  const createdDelta = Date.parse(left.createdAt) - Date.parse(right.createdAt);
  if (createdDelta !== 0) return createdDelta;
  if (left.invocationId === right.invocationId) {
    return left.sequence - right.sequence;
  }
  return left.id.localeCompare(right.id);
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
