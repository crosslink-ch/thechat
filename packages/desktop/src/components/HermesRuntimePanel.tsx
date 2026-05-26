import { useMemo } from "react";
import type {
  BotInvocationPublic,
  BotRuntimeSnapshot,
  BotSessionPublic,
} from "@thechat/shared";

const CONTEXT_LIMIT = 4;

export function HermesRuntimePanel({
  title = "Hermes",
  botName,
  runtime,
  loading,
}: {
  title?: string;
  botName: string;
  runtime: BotRuntimeSnapshot | null;
  loading: boolean;
}) {
  const contexts = useMemo(
    () => (runtime?.sessions ?? []).filter((context) => context.botKind === "hermes"),
    [runtime],
  );
  const invocations = useMemo(
    () => (runtime?.invocations ?? []).filter((invocation) => invocation.botKind === "hermes"),
    [runtime],
  );
  const activeInvocations = invocations.filter(
    (invocation) => invocation.status === "queued" || invocation.status === "running",
  );
  const contextSummaries = contexts
    .map((context) => summarizeContext(context, invocations))
    .slice(0, CONTEXT_LIMIT);

  return (
    <aside className="hidden w-80 shrink-0 flex-col border-l border-border bg-surface/70 lg:flex">
      <div className="border-b border-border px-4 py-3">
        <div className="text-[0.786rem] font-medium uppercase text-text-dimmed">{title}</div>
        <div className="truncate text-[1rem] font-semibold text-text">{botName}</div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <section className="mb-5">
          <div className="mb-2 text-[0.786rem] font-medium uppercase text-text-dimmed">
            Activity
          </div>
          {loading && activeInvocations.length === 0 ? (
            <PanelSkeleton />
          ) : activeInvocations.length === 0 ? (
            <div className="rounded-md border border-border bg-background px-3 py-2 text-[0.857rem] text-text-placeholder">
              No active runs
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {activeInvocations.map((invocation) => (
                <InvocationRow key={invocation.id} invocation={invocation} />
              ))}
            </div>
          )}
        </section>

        <section>
          <div className="mb-2 text-[0.786rem] font-medium uppercase text-text-dimmed">
            Conversation
          </div>
          {loading && contextSummaries.length === 0 ? (
            <PanelSkeleton />
          ) : contextSummaries.length === 0 ? (
            <div className="rounded-md border border-border bg-background px-3 py-2 text-[0.857rem] text-text-placeholder">
              No history yet
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {contextSummaries.map((summary) => (
                <ContextRow key={summary.context.id} summary={summary} />
              ))}
            </div>
          )}
        </section>
      </div>
    </aside>
  );
}

function InvocationRow({ invocation }: { invocation: BotInvocationPublic }) {
  return (
    <div className="rounded-md border border-border bg-background px-3 py-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1 truncate text-[0.857rem] font-medium text-text">
          {invocationPreview(invocation) || "Working"}
        </div>
        <StatusPill status={invocation.status} />
      </div>
      <div className="mt-1 text-[0.714rem] text-text-dimmed">
        {formatSessionTime(invocation.updatedAt)}
      </div>
    </div>
  );
}

function ContextRow({ summary }: { summary: ContextSummary }) {
  return (
    <div className="rounded-md border border-border bg-background px-3 py-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1 truncate text-[0.857rem] font-medium text-text">
          {summary.title}
        </div>
        {summary.latestInvocation && <StatusPill status={summary.latestInvocation.status} />}
      </div>
      <div className="mt-1 text-[0.714rem] text-text-dimmed">{summary.activityLabel}</div>
      {summary.preview ? (
        <div className="runtime-session-preview mt-2 text-[0.786rem] leading-5 text-text-muted">
          {summary.preview}
        </div>
      ) : null}
    </div>
  );
}

function PanelSkeleton() {
  return (
    <div className="space-y-2" aria-label="Loading Hermes activity">
      {Array.from({ length: 2 }, (_, index) => (
        <div
          key={index}
          className="rounded-md border border-border bg-background px-3 py-2"
        >
          <div className="flex items-start justify-between gap-2">
            <div className="h-3 w-28 animate-pulse rounded bg-raised" />
            <div className="h-4 w-12 animate-pulse rounded bg-raised" />
          </div>
          <div className="mt-2 h-2.5 w-24 animate-pulse rounded bg-raised" />
          <div className="mt-3 h-2.5 w-full animate-pulse rounded bg-raised" />
        </div>
      ))}
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const tone =
    status === "completed"
      ? "border-success-border bg-success-bg text-success"
      : status === "failed"
        ? "border-error-border bg-error-bg text-error-bright"
        : status === "cancelled"
          ? "border-border bg-raised text-text-muted"
          : status === "running"
            ? "border-accent/40 bg-accent/10 text-accent"
            : "border-border bg-raised text-text-muted";
  return (
    <span className={`shrink-0 rounded px-1.5 py-0.5 text-[0.643rem] font-medium uppercase ${tone}`}>
      {status}
    </span>
  );
}

interface ContextSummary {
  context: BotSessionPublic;
  title: string;
  activityLabel: string;
  preview: string;
  latestInvocation: BotInvocationPublic | null;
}

function summarizeContext(
  context: BotSessionPublic,
  invocations: BotInvocationPublic[],
): ContextSummary {
  const contextInvocations = invocations.filter(
    (invocation) => invocation.botSessionId === context.id,
  );
  const latestInvocation = latestByUpdatedAt(contextInvocations);

  return {
    context,
    title: contextTitle(context),
    activityLabel: latestInvocation
      ? `${statusLabel(latestInvocation.status)} ${formatSessionTime(latestInvocation.updatedAt)}`
      : context.lastMessageCreatedAt
        ? `Last message ${formatSessionTime(context.lastMessageCreatedAt)}`
        : `Created ${formatSessionTime(context.createdAt)}`,
    preview: latestInvocation
      ? invocationPreview(latestInvocation) || context.lastMessagePreview || ""
      : context.lastMessagePreview ?? "",
    latestInvocation,
  };
}

function contextTitle(context: BotSessionPublic) {
  const title = context.title?.trim();
  if (title) return title;
  return context.scope === "workspace" ? "Workspace" : "Current conversation";
}

function latestByUpdatedAt(invocations: BotInvocationPublic[]) {
  let latest: BotInvocationPublic | null = null;
  for (const invocation of invocations) {
    if (!latest || Date.parse(invocation.updatedAt) > Date.parse(latest.updatedAt)) {
      latest = invocation;
    }
  }
  return latest;
}

function statusLabel(status: string) {
  return status === "queued" ? "Queued" : "Running";
}

function invocationPreview(invocation: BotInvocationPublic) {
  return (
    textField(invocation.requestJson, "text") ||
    textField(invocation.requestJson, "messageContent") ||
    textField(invocation.responseJson, "output") ||
    textField(invocation.responseJson, "partialOutput") ||
    invocation.error ||
    ""
  );
}

function textField(source: Record<string, unknown> | null, key: string) {
  const value = source?.[key];
  return typeof value === "string" ? value.trim() : "";
}

function formatInvocationTime(iso: string) {
  const date = new Date(iso);
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatSessionTime(iso: string) {
  const date = new Date(iso);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) return formatInvocationTime(iso);
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}
