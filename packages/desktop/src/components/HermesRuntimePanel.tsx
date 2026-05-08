import type {
  BotEventPublic,
  BotInvocationPublic,
  BotRuntimeSnapshot,
  BotSessionPublic,
} from "@thechat/shared";

export function mergeRuntimeUpdate(
  prev: BotRuntimeSnapshot | null,
  session: BotSessionPublic | null,
  invocation: BotInvocationPublic,
  event: BotEventPublic | null,
): BotRuntimeSnapshot {
  const snapshot = prev ?? { sessions: [], invocations: [], events: [] };
  return {
    sessions: session ? upsertById(snapshot.sessions, session) : snapshot.sessions,
    invocations: upsertById(snapshot.invocations, invocation),
    events: event ? upsertById(snapshot.events, event) : snapshot.events,
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
}: {
  title?: string;
  botName: string;
  runtime: BotRuntimeSnapshot | null;
  loading: boolean;
}) {
  const sessions = runtime?.sessions ?? [];
  const invocations = runtime?.invocations ?? [];

  return (
    <aside className="hidden w-80 shrink-0 flex-col border-l border-border bg-surface/70 lg:flex">
      <div className="border-b border-border px-4 py-3">
        <div className="text-[0.786rem] font-medium uppercase text-text-dimmed">{title}</div>
        <div className="truncate text-[1rem] font-semibold text-text">{botName}</div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <section className="mb-5">
          <div className="mb-2 text-[0.786rem] font-medium uppercase text-text-dimmed">Sessions</div>
          {loading && sessions.length === 0 ? (
            <div className="text-[0.857rem] text-text-placeholder">Loading...</div>
          ) : sessions.length === 0 ? (
            <div className="text-[0.857rem] text-text-placeholder">No sessions yet</div>
          ) : (
            <div className="space-y-2">
              {sessions.map((session) => (
                <div key={session.id} className="rounded-md border border-border bg-background px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-[0.857rem] font-medium text-text">
                      {session.title || "Conversation"}
                    </span>
                    <StatusPill status={session.status} />
                  </div>
                  <div className="mt-1 truncate text-[0.714rem] text-text-dimmed">
                    {session.externalSessionId ?? session.id}
                  </div>
                </div>
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
