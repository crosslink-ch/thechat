import type {
  BotInvocationProgressEventPublic,
  BotInvocationPublic,
  MessagePart,
} from "@thechat/shared";
import type { ActiveHermesInvocationProgress } from "../lib/hermes-progress";
import { formatToolSummary } from "../lib/tool-summary";

type ToolCallPart = Extract<MessagePart, { type: "tool-call" }>;
type ProgressDisplayEvent = BotInvocationProgressEventPublic & {
  displayKey: string;
};

export function HermesProgressInline({
  invocations,
}: {
  invocations: ActiveHermesInvocationProgress[];
}) {
  if (invocations.length === 0) return null;

  return (
    <div className="space-y-2 px-5 py-2">
      {invocations.map(({ invocation, events }) => {
        const invocationEvents = [...events]
          .sort(compareEvents);
        const displayEvents = collapseToolLifecycleEvents(invocationEvents);
        const visibleEvents = displayEvents.slice(-6);
        const hiddenCount = Math.max(0, displayEvents.length - visibleEvents.length);

        return (
          <div key={invocation.id} className="flex gap-2.5">
            <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-elevated text-[0.857rem] font-semibold text-text-muted">
              {invocation.botName.charAt(0).toUpperCase()}
            </div>
            <div className="min-w-0 flex-1 rounded-md border border-border-subtle bg-raised/40 px-3 py-2">
              <div className="mb-1.5 flex items-center gap-2">
                <span className="inline-block size-2 shrink-0 animate-pulse rounded-full bg-accent" />
                <span className="min-w-0 flex-1 truncate text-[0.857rem] font-medium text-text-muted">
                  {invocation.botName} is working
                </span>
                <span className="shrink-0 rounded border border-accent/40 bg-accent/10 px-1.5 py-0.5 text-[0.643rem] font-medium uppercase text-accent">
                  {invocation.status}
                </span>
              </div>

              {hiddenCount > 0 && (
                <div className="pb-1 pl-4 text-[0.714rem] text-text-dimmed">
                  {hiddenCount} earlier update{hiddenCount === 1 ? "" : "s"}
                </div>
              )}

              {visibleEvents.length > 0 ? (
                <div className="space-y-1">
                  {visibleEvents.map((event) => (
                    <ProgressEventRow key={event.displayKey} event={event} />
                  ))}
                </div>
              ) : (
                <div className="pl-4 text-[0.786rem] text-text-dimmed">
                  {emptyStateLabel(invocation)}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function collapseToolLifecycleEvents(
  events: BotInvocationProgressEventPublic[],
): ProgressDisplayEvent[] {
  const rows: ProgressDisplayEvent[] = [];
  const toolRowsByCallId = new Map<string, ProgressDisplayEvent>();

  for (const event of events) {
    if (!event.toolCallId) {
      rows.push({ ...event, displayKey: event.id });
      continue;
    }

    const existing = toolRowsByCallId.get(event.toolCallId);
    if (!existing) {
      const row = { ...event, displayKey: `tool:${event.toolCallId}` };
      rows.push(row);
      toolRowsByCallId.set(event.toolCallId, row);
      continue;
    }

    Object.assign(existing, {
      ...event,
      displayKey: existing.displayKey,
      label: existing.label?.trim() ? existing.label : event.label,
      preview: existing.preview?.trim() ? existing.preview : event.preview,
    });
  }

  return rows.sort(compareEvents);
}

function emptyStateLabel(invocation: BotInvocationPublic) {
  if (invocation.status === "queued") return "Queued";
  if (invocation.status === "running" && olderThan(invocation.startedAt, 30_000)) {
    return "No recent tool updates";
  }
  return "Waiting for the next Hermes update";
}

function olderThan(iso: string | null, ageMs: number) {
  if (!iso) return false;
  return Date.now() - Date.parse(iso) > ageMs;
}

function ProgressEventRow({ event }: { event: BotInvocationProgressEventPublic }) {
  const status = event.status ?? statusFromType(event.type);
  const payload = event.payload ?? {};
  const duration = typeof payload.duration === "number" ? payload.duration : null;

  return (
    <div className="flex min-w-0 items-center gap-2 text-[0.786rem] text-text-muted">
      <StatusDot status={status} />
      <span className="min-w-0 flex-1 truncate">{eventLabel(event)}</span>
      {duration !== null && (
        <span className="shrink-0 tabular-nums text-text-dimmed">
          {formatDuration(duration)}
        </span>
      )}
    </div>
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

function compareEvents(
  a: BotInvocationProgressEventPublic,
  b: BotInvocationProgressEventPublic,
) {
  if (a.sequence !== b.sequence) return a.sequence - b.sequence;
  return Date.parse(a.createdAt) - Date.parse(b.createdAt);
}
