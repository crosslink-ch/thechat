import { useMemo } from "react";
import type {
  BotInvocationPublic,
  BotRuntimeSnapshot,
  ConversationThreadPublic,
} from "@thechat/shared";

export function HermesRuntimePanel({
  title = "Hermes",
  botName,
  runtime,
  loading,
  threads = [],
  threadsLoading = false,
  threadsLoadingMore = false,
  threadsHasMore = false,
  activeThreadId = null,
  queuedCountsByThread,
  generalQueuedCount = 0,
  onSelectThread,
  onCreateThread,
  onLoadMoreThreads,
}: {
  title?: string;
  botName: string;
  runtime: BotRuntimeSnapshot | null;
  loading: boolean;
  threads?: ConversationThreadPublic[];
  threadsLoading?: boolean;
  threadsLoadingMore?: boolean;
  threadsHasMore?: boolean;
  activeThreadId?: string | null;
  queuedCountsByThread?: Map<string, number>;
  generalQueuedCount?: number;
  onSelectThread?: (threadId: string | null) => void;
  onCreateThread?: () => void;
  onLoadMoreThreads?: () => void;
}) {
  const invocations = useMemo(
    () => (runtime?.invocations ?? []).filter((invocation) => invocation.botKind === "hermes"),
    [runtime],
  );
  const activeInvocations = invocations.filter(
    (invocation) => invocation.status === "queued" || invocation.status === "running",
  );
  const activeCountsByThread = useMemo(() => {
    const counts = new Map<string, number>();
    for (const invocation of activeInvocations) {
      if (!invocation.threadId) continue;
      counts.set(invocation.threadId, (counts.get(invocation.threadId) ?? 0) + 1);
    }
    return counts;
  }, [activeInvocations]);
  const generalActiveCount = activeInvocations.filter(
    (invocation) => invocation.threadId === null,
  ).length;

  return (
    <aside className="hidden w-80 shrink-0 flex-col border-l border-border bg-surface/70 lg:flex">
      <div className="border-b border-border px-4 py-3">
        <div className="text-[0.786rem] font-medium uppercase text-text-dimmed">{title}</div>
        <div className="truncate text-[1rem] font-semibold text-text">{botName}</div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <section className="mb-5">
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="text-[0.786rem] font-medium uppercase text-text-dimmed">
              Tasks
            </div>
            {onCreateThread && (
              <button
                type="button"
                className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md border border-border bg-background text-text-muted transition-colors duration-150 hover:bg-hover hover:text-text"
                onClick={onCreateThread}
                title="New task"
              >
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                  <path d="M6 2.5V9.5" />
                  <path d="M2.5 6H9.5" />
                </svg>
              </button>
            )}
          </div>
          <div className="flex flex-col gap-1.5">
            <GeneralThreadRow
              active={activeThreadId === null}
              activeCount={generalActiveCount + generalQueuedCount}
              onSelect={onSelectThread}
            />
            {threadsLoading && threads.length === 0 ? (
              <PanelSkeleton />
            ) : (
              threads.map((thread) => (
                <ThreadRow
                  key={thread.id}
                  thread={thread}
                  active={thread.id === activeThreadId}
                  activeCount={
                    (activeCountsByThread.get(thread.id) ?? 0) +
                    (queuedCountsByThread?.get(thread.id) ?? 0)
                  }
                  onSelect={onSelectThread}
                />
              ))
            )}
            {threadsHasMore && (
              <button
                type="button"
                className="w-full cursor-pointer rounded-md border border-border bg-background px-3 py-2 text-center text-[0.786rem] font-medium text-text-muted transition-colors duration-150 hover:bg-hover hover:text-text disabled:cursor-default disabled:opacity-50"
                onClick={onLoadMoreThreads}
                disabled={threadsLoadingMore}
              >
                {threadsLoadingMore ? "Loading..." : "Load more"}
              </button>
            )}
          </div>
        </section>
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
      </div>
    </aside>
  );
}

function ThreadRow({
  thread,
  active,
  activeCount,
  onSelect,
}: {
  thread: ConversationThreadPublic;
  active: boolean;
  activeCount: number;
  onSelect?: (threadId: string | null) => void;
}) {
  return (
    <button
      type="button"
      className={`w-full cursor-pointer rounded-md border px-3 py-2 text-left transition-colors duration-150 ${
        active
          ? "border-accent/40 bg-accent/10"
          : "border-border bg-background hover:bg-hover"
      }`}
      onClick={() => onSelect?.(thread.id)}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1 truncate text-[0.857rem] font-medium text-text">
          {thread.title}
        </div>
        {activeCount > 0 && (
          <span className="shrink-0 rounded border border-accent/40 bg-accent/10 px-1.5 py-0.5 text-[0.643rem] font-medium uppercase text-accent">
            {activeCount}
          </span>
        )}
      </div>
      <div className="mt-1 text-[0.714rem] text-text-dimmed">
        {formatSessionTime(thread.lastActivityAt)}
      </div>
    </button>
  );
}

function GeneralThreadRow({
  active,
  activeCount,
  onSelect,
}: {
  active: boolean;
  activeCount: number;
  onSelect?: (threadId: string | null) => void;
}) {
  return (
    <button
      type="button"
      className={`w-full cursor-pointer rounded-md border px-3 py-2 text-left transition-colors duration-150 ${
        active
          ? "border-accent/40 bg-accent/10"
          : "border-border bg-background hover:bg-hover"
      }`}
      onClick={() => onSelect?.(null)}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1 truncate text-[0.857rem] font-medium text-text">
          General
        </div>
        {activeCount > 0 && (
          <span className="shrink-0 rounded border border-accent/40 bg-accent/10 px-1.5 py-0.5 text-[0.643rem] font-medium uppercase text-accent">
            {activeCount}
          </span>
        )}
      </div>
      <div className="mt-1 text-[0.714rem] text-text-dimmed">
        Inbox
      </div>
    </button>
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
