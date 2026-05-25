import { useEffect, useMemo, useState } from "react";
import type {
  BotInvocationPublic,
  BotRuntimeSnapshot,
  BotSessionPublic,
} from "@thechat/shared";

const INITIAL_SESSION_LIMIT = 20;
const SESSION_PAGE_SIZE = 20;

export function HermesRuntimePanel({
  title = "Hermes",
  botName,
  runtime,
  loading,
  activeSessionId,
  creatingSession = false,
  onCreateSession,
  onSelectSession,
}: {
  title?: string;
  botName: string;
  runtime: BotRuntimeSnapshot | null;
  loading: boolean;
  activeSessionId?: string | null;
  creatingSession?: boolean;
  onCreateSession?: () => void;
  onSelectSession?: (sessionId: string) => void;
}) {
  const sessions = runtime?.sessions ?? [];
  const invocations = runtime?.invocations ?? [];
  const [visibleSessionCount, setVisibleSessionCount] = useState(INITIAL_SESSION_LIMIT);
  const sessionResetKey = `${title}:${botName}:${sessions[0]?.conversationId ?? ""}`;
  const hasMultipleBots = useMemo(
    () => new Set(sessions.map((session) => session.botId)).size > 1,
    [sessions],
  );
  const sessionSummaries = useMemo(
    () =>
      sessions.map((session, index) =>
        summarizeSession(session, invocations, index),
      ),
    [invocations, sessions],
  );
  const visibleSessionSummaries = sessionSummaries.slice(0, visibleSessionCount);
  const hiddenSessionCount = Math.max(0, sessionSummaries.length - visibleSessionSummaries.length);

  useEffect(() => {
    setVisibleSessionCount(INITIAL_SESSION_LIMIT);
  }, [sessionResetKey]);

  return (
    <aside className="hidden w-80 shrink-0 flex-col border-l border-border bg-surface/70 lg:flex">
      <div className="border-b border-border px-4 py-3">
        <div className="text-[0.786rem] font-medium uppercase text-text-dimmed">{title}</div>
        <div className="truncate text-[1rem] font-semibold text-text">{botName}</div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <section className="mb-5">
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="text-[0.786rem] font-medium uppercase text-text-dimmed">Sessions</div>
            {onCreateSession && (
              <button
                type="button"
                className="rounded border border-border bg-raised px-2 py-1 text-[0.714rem] font-medium text-text-muted transition-colors hover:bg-hover hover:text-text disabled:cursor-not-allowed disabled:opacity-60"
                onClick={onCreateSession}
                disabled={creatingSession}
              >
                {creatingSession ? "Creating" : "+ New"}
              </button>
            )}
          </div>
          {loading && sessions.length === 0 ? (
            <SessionSkeletonList />
          ) : sessions.length === 0 ? (
            <div className="text-[0.857rem] text-text-placeholder">No sessions yet</div>
          ) : (
            <div className="flex flex-col gap-2">
              {visibleSessionSummaries.map((summary) => (
                <SessionRow
                  key={summary.session.id}
                  summary={summary}
                  active={activeSessionId === summary.session.id}
                  selectable={!!onSelectSession}
                  showBotName={hasMultipleBots}
                  onSelect={() => onSelectSession?.(summary.session.id)}
                />
              ))}
              {hiddenSessionCount > 0 && (
                <button
                  type="button"
                  className="w-full rounded-md border border-border bg-raised px-3 py-2 text-[0.786rem] font-medium text-text-muted transition-colors hover:bg-hover hover:text-text"
                  onClick={() =>
                    setVisibleSessionCount((count) =>
                      Math.min(count + SESSION_PAGE_SIZE, sessionSummaries.length),
                    )
                  }
                >
                  Show {Math.min(SESSION_PAGE_SIZE, hiddenSessionCount)} more
                </button>
              )}
              {sessionSummaries.length > INITIAL_SESSION_LIMIT && (
                <div className="px-1 text-center text-[0.714rem] text-text-dimmed">
                  Showing {visibleSessionSummaries.length} of {sessionSummaries.length} recent sessions
                </div>
              )}
            </div>
          )}
        </section>
      </div>
    </aside>
  );
}

function SessionSkeletonList() {
  return (
    <div className="space-y-2" aria-label="Loading sessions">
      {Array.from({ length: 3 }, (_, index) => (
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
          <div className="mt-1.5 h-2.5 w-3/4 animate-pulse rounded bg-raised" />
        </div>
      ))}
    </div>
  );
}

function SessionRow({
  summary,
  active,
  selectable,
  showBotName,
  onSelect,
}: {
  summary: SessionSummary;
  active: boolean;
  selectable: boolean;
  showBotName: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className={`block w-full overflow-hidden rounded-md border px-3 py-2 text-left transition-colors ${
        active
          ? "border-accent/50 bg-accent/10"
          : "border-border bg-background hover:bg-hover"
      } ${selectable ? "cursor-pointer" : "cursor-default"}`}
      onClick={onSelect}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1 truncate text-[0.857rem] font-medium text-text">
          {summary.title}
        </div>
        {summary.latestInvocation && <StatusPill status={summary.latestInvocation.status} />}
      </div>

      <div className="mt-1 flex min-w-0 items-center gap-1.5 text-[0.714rem] text-text-dimmed">
        {showBotName && (
          <>
            <span className="truncate">{summary.session.botName}</span>
            <span className="shrink-0">/</span>
          </>
        )}
        <span className="shrink-0">{summary.activityLabel}</span>
      </div>

      {summary.preview ? (
        <div className="runtime-session-preview mt-2 text-[0.786rem] leading-5 text-text-muted">
          {summary.preview}
        </div>
      ) : (
        <div className="mt-2 truncate text-[0.786rem] leading-5 text-text-placeholder">
          No messages yet
        </div>
      )}
    </button>
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

function formatInvocationTime(iso: string) {
  const date = new Date(iso);
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

interface SessionSummary {
  session: BotSessionPublic;
  title: string;
  activityLabel: string;
  preview: string;
  latestInvocation: BotInvocationPublic | null;
}

function summarizeSession(
  session: BotSessionPublic,
  invocations: BotInvocationPublic[],
  index: number,
): SessionSummary {
  const sessionInvocations = invocations.filter(
    (invocation) => invocation.botSessionId === session.id,
  );
  const latestInvocation = latestByUpdatedAt(sessionInvocations);

  return {
    session,
    title: sessionTitle(session, index),
    activityLabel: latestInvocation
      ? `${statusLabel(latestInvocation.status)} ${formatSessionTime(latestInvocation.updatedAt)}`
      : session.lastMessageCreatedAt
        ? `Last message ${formatSessionTime(session.lastMessageCreatedAt)}`
        : `Created ${formatSessionTime(session.createdAt)}`,
    preview: latestInvocation
      ? invocationPreview(latestInvocation) || session.lastMessagePreview || ""
      : session.lastMessagePreview ?? "",
    latestInvocation,
  };
}

function sessionTitle(session: BotSessionPublic, index: number) {
  const title = session.title?.trim();
  if (title) return title;
  const isDefaultSession = !session.externalSessionId?.includes(":session:");
  if (isDefaultSession) return "Default session";
  return `Session ${index + 1}`;
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

function formatSessionTime(iso: string) {
  const date = new Date(iso);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) return formatInvocationTime(iso);
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}
