import type {
  BotInvocationPublic,
  BotRuntimeSnapshot,
  BotSessionPublic,
} from "@thechat/shared";

export function mergeRuntimeUpdate(
  prev: BotRuntimeSnapshot | null,
  session: BotSessionPublic | null,
  invocation: BotInvocationPublic,
): BotRuntimeSnapshot {
  const snapshot = prev ?? { sessions: [], invocations: [] };
  return {
    sessions: session ? upsertById(snapshot.sessions, session) : snapshot.sessions,
    invocations: upsertById(snapshot.invocations, invocation),
  };
}

function upsertById<T extends { id: string }>(items: T[], item: T) {
  const next = items.filter((existing) => existing.id !== item.id);
  next.unshift(item);
  return next;
}

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
  const invocations = activeSessionId
    ? (runtime?.invocations ?? []).filter((invocation) => invocation.botSessionId === activeSessionId)
    : runtime?.invocations ?? [];

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
            <div className="text-[0.857rem] text-text-placeholder">Loading...</div>
          ) : sessions.length === 0 ? (
            <div className="text-[0.857rem] text-text-placeholder">No sessions yet</div>
          ) : (
            <div className="space-y-2">
              {sessions.map((session) => (
                <button
                  type="button"
                  key={session.id}
                  className={`w-full rounded-md border px-3 py-2 text-left transition-colors ${
                    activeSessionId === session.id
                      ? "border-accent/50 bg-accent/10"
                      : "border-border bg-background hover:bg-hover"
                  } ${onSelectSession ? "cursor-pointer" : "cursor-default"}`}
                  onClick={() => onSelectSession?.(session.id)}
                >
                  <div className="truncate text-[0.857rem] font-medium text-text">
                    {session.title || "Conversation"}
                  </div>
                  <div className="mt-1 truncate text-[0.714rem] text-text-dimmed">
                    {session.externalSessionId ?? session.id}
                  </div>
                </button>
              ))}
            </div>
          )}
        </section>

        <section>
          <div className="mb-2 text-[0.786rem] font-medium uppercase text-text-dimmed">Activity</div>
          {loading && invocations.length === 0 ? (
            <div className="text-[0.857rem] text-text-placeholder">Loading...</div>
          ) : invocations.length === 0 ? (
            <div className="text-[0.857rem] text-text-placeholder">No activity yet</div>
          ) : (
            <div className="space-y-2">
              {invocations.map((invocation) => (
                <InvocationRow key={invocation.id} invocation={invocation} />
              ))}
            </div>
          )}
        </section>
      </div>
    </aside>
  );
}

function InvocationRow({ invocation }: { invocation: BotInvocationPublic }) {
  const partial = typeof invocation.responseJson?.partialOutput === "string"
    ? invocation.responseJson.partialOutput
    : "";
  const output = typeof invocation.responseJson?.output === "string"
    ? invocation.responseJson.output
    : partial;

  return (
    <div className="rounded-md border border-border bg-background px-3 py-2">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-[0.857rem] font-medium text-text">{formatInvocationTime(invocation.createdAt)}</span>
        <StatusPill status={invocation.status} />
      </div>
      {invocation.externalRunId && (
        <div className="truncate text-[0.714rem] text-text-dimmed">{invocation.externalRunId}</div>
      )}
      {output && (
        <div className="mt-2 line-clamp-3 text-[0.786rem] leading-5 text-text-muted">{output}</div>
      )}
      {invocation.error && (
        <div className="mt-2 line-clamp-3 text-[0.786rem] leading-5 text-error-bright">{invocation.error}</div>
      )}
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

function formatInvocationTime(iso: string) {
  const date = new Date(iso);
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
