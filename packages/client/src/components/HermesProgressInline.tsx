import { useEffect, useState } from "react";
import type {
  BotAppearance,
  BotInvocationProgressEventPublic,
  BotInvocationPublic,
  MessagePart,
} from "@thechat/shared";
import type { ActiveHermesInvocationProgress } from "../lib/hermes-progress";
import { useBotRequestsStore } from "../stores/bot-requests";
import { formatToolSummary } from "../lib/tool-summary";
import {
  Brain,
  CircleAlert,
  Clock3,
  Info,
  LoaderCircle,
  Square,
  TriangleAlert,
  Wrench,
  X,
} from "lucide-react";
import {
  ExpandChevron,
  StepIcon,
  StepOrb,
} from "./hermes-steps";
import { botAppearanceFor, botAvatarsOf } from "../lib/bot-appearance";
import { useWorkspacesStore } from "../stores/workspaces";
import { Avatar } from "./Avatar";
import { buttonClass } from "./ui";
import { HermesVaultUnlock, type VaultUnlockCallback } from "./HermesVaultUnlock";
import { deriveVaultUnlockStates, type VaultUnlockState } from "../lib/hermes-vault-unlock";
import { HermesSecureInput, type SecureInputCallback } from "./HermesSecureInput";
import { deriveSecureInputStates, type SecureInputState } from "../lib/hermes-secure-input";
import { useAuthStore } from "../stores/auth";

type ToolCallPart = Extract<MessagePart, { type: "tool-call" }>;
type NoticeSeverity = "info" | "warning" | "error";

/**
 * One visual row in the activity timeline. Rows are built by walking the
 * invocation's events in sequence order, so the list reflects the actual
 * order things happened: a tool row sits where the tool started (its
 * completion only updates it in place), a thinking row sits where that
 * reasoning block began (consecutive reasoning events collapse into it).
 * Approvals and questions are bot requests and render from their rows.
 */
type EventRow = {
  kind: "tool" | "notice" | "reasoning" | "other";
  key: string;
  event: BotInvocationProgressEventPublic;
};
type VaultRow = {kind:"vault";key:string;state:VaultUnlockState};
type ActivityRow = EventRow | VaultRow | { kind: "secure"; key: string; state: SecureInputState };

const MAX_VISIBLE_ROWS = 8;
const MAX_UI_LABEL_CHARS = 4_000;
const MAX_UI_DETAIL_CHARS = 20_000;

export function HermesProgressInline({
  invocations,
  onVaultUnlock,
  onSecureInput,
  onStop,
  botAppearances,
}: {
  invocations: ActiveHermesInvocationProgress[];
  /** Saved identities from the displayed conversation, independent of sidebar selection. */
  botAppearances?: ReadonlyMap<string, BotAppearance>;
  onStop?: () => void;
  onVaultUnlock?: VaultUnlockCallback;
  onSecureInput?: SecureInputCallback;
}) {
  const self = useAuthStore(state=>state.user);
  const requestsById = useBotRequestsStore((state) => state.byId);
  const members = useWorkspacesStore((state) => state.activeWorkspace?.members);
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

  return (
    <div className="py-1">
      {invocations.filter(({ invocation }) => !["completed", "failed", "cancelled"].includes(invocation.status)).map(({ invocation, events }) => {
        const invocationEvents = [...events].sort(compareEvents);
        // Open requests this run is blocked on. The cards themselves render
        // from request rows (BotRequestTimeline), not from progress events.
        const openRequests = Object.values(requestsById).filter(
          (request) =>
            request.invocationId === invocation.id && request.status === "open",
        );
        const needsApproval = openRequests.some((request) => request.kind === "approval");
        const needsClarification = openRequests.some(
          (request) => request.kind !== "approval",
        );
        const vaultStates = deriveVaultUnlockStates(invocationEvents,nowMs)
          .filter(state=>self?.type === "human" && state.request.requesterUserId === self.id);
        const needsVaultUnlock = vaultStates.some(state=>state.outcome === null);
        const secureStates = deriveSecureInputStates(invocationEvents, nowMs)
          .filter(state => self?.type === "human" && state.request.requesterUserId === self.id);
        const needsSecureInput = secureStates.some(state => state.outcome === null);
        const needsInteraction = needsApproval || needsClarification || needsVaultUnlock || needsSecureInput;
        const rows = buildActivityRows(invocationEvents, vaultStates, secureStates);
        const working = invocation.status === "running" && !needsInteraction;
        const appearance = botAppearanceFor(
          invocation.botUserId,
          (members && botAvatarsOf(members).get(invocation.botUserId))
            ?? botAppearances?.get(invocation.botUserId),
        );
        let visibleRows = rows.slice(-MAX_VISIBLE_ROWS);
        // Keep pending interactions actionable even when older than the
        // visible window; ordinary activity remains in event order.
        const hiddenPending = rows.filter(
          (row) =>
            (row.kind === "vault" || row.kind === "secure") && row.state.outcome === null &&
            !visibleRows.includes(row),
        );
        visibleRows = [...hiddenPending, ...visibleRows];
        const hiddenCount = rows.length - visibleRows.length;
        const renderRow = (row: ActivityRow) => (
          <div
            key={row.key}
            data-testid="hermes-activity-row"
            data-kind={rowKind(row)}
          >

            {row.kind === "secure" ? (
              <HermesSecureInput state={row.state} onResponse={onSecureInput} />
            ) : row.kind === "vault" ? (
              <HermesVaultUnlock key={JSON.stringify([row.state.event.id,row.state.request])} state={row.state} onResponse={onVaultUnlock}/>
            ) : row.kind === "notice" ? (
              <NoticeEventRow event={row.event} />
            ) : row.kind === "reasoning" ? (
              <ReasoningEventRow
                event={row.event}
                animated={working}
                expanded={expandedRowKeys.has(row.key)}
                onToggle={() => toggleRow(row.key)}
              />
            ) : row.kind === "tool" ? (
              <ToolEventRow
                event={row.event}
                animated={working}
                expanded={expandedRowKeys.has(row.key)}
                onToggle={() => toggleRow(row.key)}
              />
            ) : (
              <OtherEventRow event={row.event} />
            )}
          </div>
        );
        const elapsedLabel = invocation.startedAt
          ? formatElapsed(nowMs - Date.parse(invocation.startedAt))
          : null;
        const title = needsApproval
          ? "is waiting for your approval"
          : needsClarification || needsVaultUnlock || needsSecureInput
            ? "is waiting for your response"
          : invocation.status === "queued"
            ? "is queued"
            : "is working";

        return (
          <div
            key={invocation.id}
            className="flex gap-2.5 px-5 py-2.5 transition-colors duration-100 hover:bg-raised/30"
          >
            {/* Only the explicitly selected Minimal style uses standard status
                indicators. Playful avatars retain their hopping/idle behavior. */}
            {appearance.shape === "minimal" ? (
              <span
                data-testid="hermes-invocation-indicator"
                aria-hidden="true"
                className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-elevated text-text-dimmed"
              >
                {needsInteraction ? <CircleAlert size={18} /> : working ? (
                  <LoaderCircle size={18} className="motion-safe:animate-spin" />
                ) : <Clock3 size={18} />}
              </span>
            ) : (
              <Avatar
                name={invocation.botName}
                colorKey={invocation.botUserId}
                bot
                botAvatar={appearance}
                botMotion={working ? "working" : needsInteraction ? "idle" : "still"}
                size={32}
                className="mt-0.5 size-8 text-[0.857rem]"
              />
            )}
            <div className="min-w-0 flex-1">
              <div className="mb-1 flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
                <span className="min-w-0 text-[0.929rem] font-medium text-text-secondary">
                  {invocation.botName} {title}
                </span>
                {needsInteraction && (
                  <span className="shrink-0 rounded-full border border-warning/25 bg-warning-bg px-2 py-0.5 text-[0.714rem] font-medium text-warning-text">
                    action needed
                  </span>
                )}
                <div className="ml-auto flex shrink-0 items-center gap-2">
                  {elapsedLabel && (
                    <span className="tabular-nums text-[0.786rem] text-text-dimmed">
                      {elapsedLabel}
                    </span>
                  )}
                  {onStop && invocation.status !== "queued" && (
                    <button
                      type="button"
                      className={buttonClass("secondary", "sm")}
                      onClick={onStop}
                    >
                      <Square size={12} aria-hidden="true" className="fill-current" />
                      Stop
                    </button>
                  )}
                </div>
              </div>

              <div className="min-w-0 space-y-0.5">
                {hiddenCount > 0 && (
                  <div className="px-1 py-1 text-[0.857rem] text-text-dimmed">
                    {hiddenCount} earlier update{hiddenCount === 1 ? "" : "s"}
                  </div>
                )}
                {visibleRows.length > 0 ? visibleRows.map(renderRow) : (
                  <div className="px-1 py-1 text-[0.929rem] text-text-dimmed">
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
  vaultStates: VaultUnlockState[],
  secureStates: SecureInputState[],
): ActivityRow[] {
  const rows: ActivityRow[] = [];
  const toolRowByCallId = new Map<string, EventRow>();

  for (const event of sortedEvents) {
    if (event.type.startsWith("secure.input.")) {
      const state = secureStates.find(state => state.event.id === event.id);
      if (state) rows.push({ kind: "secure", key: event.id, state });
      continue;
    }
    if (event.type.startsWith("vault.unlock.")) {
      const state = vaultStates.find(state=>state.event.id === event.id);
      if (state) rows.push({kind:"vault",key:event.id,state});
      continue;
    }
    // Approval/clarify progress from an older gateway: request rows carry
    // these now, so they never render as activity.
    if (event.type.startsWith("approval.") || event.type.startsWith("clarify.")) continue;

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
        label:
          trimmedUiString(existing.event.label) ||
          trimmedUiString(event.label) ||
          null,
        preview:
          trimmedUiString(existing.event.preview) ||
          trimmedUiString(event.preview) ||
          null,
      };
      continue;
    }

    rows.push({ kind: "other", key: event.id, event });
  }

  return rows;
}

function rowKind(row: ActivityRow) {
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

/** Shared geometry for one-line timeline steps. */
const stepRowClass =
  "flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-1 py-1 text-left text-[0.929rem] text-text-muted transition-colors hover:bg-white/[0.03] hover:text-text-secondary";

/** Expanded step details, indented under the step's text. */
const stepDetailClass =
  "mb-1.5 ml-8 mt-0.5 block max-h-72 overflow-y-auto whitespace-pre-wrap rounded-lg border border-border-subtle bg-raised px-3 py-2 leading-relaxed";

function toolStatus(event: BotInvocationProgressEventPublic) {
  return event.status ?? statusFromType(event.type);
}

function ToolEventRow({
  event,
  animated,
  expanded,
  onToggle,
}: {
  event: BotInvocationProgressEventPublic;
  animated: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  const status = toolStatus(event);
  const payload = event.payload ?? {};
  const duration = typeof payload.duration === "number" ? payload.duration : null;
  const meta = [event.toolName, duration !== null ? formatDuration(duration) : null]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="min-w-0">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        className={stepRowClass}
        title={meta || undefined}
      >
        {status === "running" && animated ? (
          <StepOrb state="working" />
        ) : status === "failed" ? (
          <StepIcon icon={X} className="text-error-bright" />
        ) : (
          <StepIcon icon={Wrench} />
        )}
        {event.toolName && (
          <span
            className="max-w-[10rem] shrink-0 truncate rounded-md border border-border-subtle bg-raised px-1.5 py-0.5 font-mono text-[0.786rem] text-text-dimmed"
            title={event.toolName}
          >
            {event.toolName}
          </span>
        )}
        <span className="min-w-0 flex-1 truncate">{eventLabel(event)}</span>
        {duration !== null && (
          <span className="shrink-0 tabular-nums text-[0.786rem] text-text-dimmed">
            {formatDuration(duration)}
          </span>
        )}
        <ExpandChevron expanded={expanded} />
      </button>
      {expanded && (
        <div
          data-testid="hermes-activity-detail"
          className={`${stepDetailClass} text-[0.786rem]`}
        >
          {meta && (
            <div className="mb-1 flex gap-2 font-mono text-[0.714rem] text-text-dimmed">
              {event.toolName && <span>{event.toolName}</span>}
              {duration !== null && (
                <span className="tabular-nums">{formatDuration(duration)}</span>
              )}
            </div>
          )}
          <code className="block break-all font-mono text-text-secondary">
            {toolDetailText(event)}
          </code>
        </div>
      )}
    </div>
  );
}

function NoticeEventRow({ event }: { event: BotInvocationProgressEventPublic }) {
  const severity = noticeSeverity(event);
  const tone =
    severity === "error"
      ? "text-error-bright"
      : severity === "warning"
        ? "text-warning-text"
        : "text-text-muted";
  const badge = severity === "warning" ? "warn" : severity;

  return (
    <div className={`flex min-w-0 items-start gap-2 px-1 py-1 text-[0.929rem] ${tone}`}>
      <StepIcon
        icon={severity === "error" ? CircleAlert : severity === "warning" ? TriangleAlert : Info}
        className={`mt-px ${severity === "info" ? "text-text-dimmed" : tone}`}
      />
      <span className="mt-0.5 shrink-0 rounded-sm border border-current/30 px-1.5 text-[0.643rem] font-medium uppercase leading-4">
        {badge}
      </span>
      <span className="min-w-0 whitespace-pre-wrap break-words leading-relaxed">
        {eventText(event)}
      </span>
    </div>
  );
}

function ReasoningEventRow({
  event,
  animated,
  expanded,
  onToggle,
}: {
  event: BotInvocationProgressEventPublic;
  animated: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  const fullText = eventText(event);
  const previewText = firstLine(fullText);

  return (
    <div className="min-w-0">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        className={stepRowClass}
      >
        {animated ? <StepOrb state="solving" /> : <StepIcon icon={Brain} />}
        <span className="shrink-0 font-medium text-text-secondary">Thinking</span>
        <span className="min-w-0 flex-1 truncate text-text-dimmed">
          {!expanded && previewText}
        </span>
        <ExpandChevron expanded={expanded} />
      </button>
      {expanded && fullText && (
        <div
          data-testid="hermes-activity-detail"
          className={`${stepDetailClass} break-words text-text-muted`}
        >
          {fullText}
        </div>
      )}
    </div>
  );
}

function OtherEventRow({ event }: { event: BotInvocationProgressEventPublic }) {
  return (
    <div className="flex min-w-0 items-center gap-2 px-1 py-1 text-[0.929rem] text-text-dimmed">
      <StepIcon icon={Info} />
      <span className="shrink-0 font-medium text-text-muted">Update</span>
      <span className="min-w-0 flex-1 truncate">{eventText(event)}</span>
    </div>
  );
}

function eventLabel(event: BotInvocationProgressEventPublic) {
  const label = trimmedUiString(event.label);
  if (label) {
    return boundedUiText(label, MAX_UI_LABEL_CHARS);
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
  const preview = trimmedUiString(event.preview);
  if (preview) {
    return boundedUiText(preview, MAX_UI_LABEL_CHARS);
  }
  return event.type.replace(/\./g, " ");
}

/** Fullest available text for an expanded tool row. */
function toolDetailText(event: BotInvocationProgressEventPublic) {
  const candidates = [
    trimmedUiString(event.label),
    trimmedUiString(event.preview),
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
  const label = trimmedUiString(event.label);
  if (label) {
    return boundedUiText(label, MAX_UI_LABEL_CHARS);
  }
  const preview = trimmedUiString(event.preview);
  if (preview) {
    return boundedUiText(preview, MAX_UI_LABEL_CHARS);
  }
  const payloadText = stringField(event.payload, "text");
  if (payloadText) return boundedUiText(payloadText, MAX_UI_DETAIL_CHARS);
  return event.type.replace(/\./g, " ");
}

function stringField(source: Record<string, unknown> | null, key: string) {
  return trimmedUiString(source?.[key]);
}

function trimmedUiString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function boundedUiText(value: string, maxChars: number) {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 1))}…`;
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
