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
  approvalThreadIds,
  generalNeedsApproval = false,
  unreadThreadIds,
  generalUnread = false,
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
  approvalThreadIds?: Set<string>;
  generalNeedsApproval?: boolean;
  unreadThreadIds?: Set<string>;
  generalUnread?: boolean;
  onSelectThread?: (threadId: string | null) => void;
  onCreateThread?: () => void;
  onLoadMoreThreads?: () => void;
}) {
  const invocations = useMemo(
    () => (runtime?.invocations ?? []).filter((invocation) => invocation.botKind === "hermes"),
    [runtime],
  );
  const progressInvocationIds = new Set(
    (runtime?.events ?? []).map((event) => event.invocationId),
  );
  const activeInvocations = invocations.filter(
    (invocation) =>
      invocation.status === "queued" || progressInvocationIds.has(invocation.id),
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
    <aside className="hidden w-80 shrink-0 flex-col border-l border-border bg-surface/80 lg:flex">
      <div className="border-b border-border px-4 py-3.5">
        <div className="text-[0.786rem] font-medium uppercase text-text-dimmed">{title}</div>
        <div className="truncate text-[1rem] font-semibold text-text">{botName}</div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3.5 py-4">
        <section className="mb-5">
          <div className="mb-2 px-1 text-[0.786rem] font-medium uppercase text-text-dimmed">
            General
          </div>
          <GeneralThreadRow
            active={activeThreadId === null}
            activeCount={generalActiveCount + generalQueuedCount}
            needsApproval={generalNeedsApproval}
            unread={generalUnread && activeThreadId !== null}
            onSelect={onSelectThread}
          />
        </section>

        <section className="mb-5">
          <div className="mb-2 flex items-center justify-between gap-2 px-1">
            <div className="text-[0.786rem] font-medium uppercase text-text-dimmed">
              Tasks
            </div>
            {onCreateThread && (
              <button
                type="button"
                className="flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-md border border-accent/35 bg-accent/10 px-2 text-[0.786rem] font-medium text-accent transition-colors duration-150 hover:border-accent/55 hover:bg-accent/15 hover:text-text"
                onClick={onCreateThread}
                title="New task (C-x n)"
                aria-label="New task"
              >
                <PlusIcon className="size-3" />
                <span>New</span>
              </button>
            )}
          </div>
          {threadsLoading && threads.length === 0 ? (
            <PanelSkeleton />
          ) : threads.length === 0 ? (
            <div className="rounded-md border border-dashed border-border-subtle bg-base/20 px-3 py-3 text-[0.857rem] text-text-placeholder">
              No tasks yet
            </div>
          ) : (
            <div className="overflow-hidden rounded-md border border-border-subtle bg-base/20">
              <div className="divide-y divide-border-subtle">
                {threads.map((thread) => (
                  <ThreadRow
                    key={thread.id}
                    thread={thread}
                    active={thread.id === activeThreadId}
                    activeCount={
                      (activeCountsByThread.get(thread.id) ?? 0) +
                      (queuedCountsByThread?.get(thread.id) ?? 0)
                    }
                    needsApproval={approvalThreadIds?.has(thread.id) ?? false}
                    unread={
                      thread.id !== activeThreadId &&
                      (unreadThreadIds?.has(thread.id) ?? false)
                    }
                    onSelect={onSelectThread}
                  />
                ))}
              </div>
            </div>
          )}
          {threadsHasMore && (
            <button
              type="button"
              className="mt-2 w-full cursor-pointer rounded-md border border-border bg-background px-3 py-2 text-center text-[0.786rem] font-medium text-text-muted transition-colors duration-150 hover:bg-hover hover:text-text disabled:cursor-default disabled:opacity-50"
              onClick={onLoadMoreThreads}
              disabled={threadsLoadingMore}
            >
              {threadsLoadingMore ? "Loading..." : "Load more"}
            </button>
          )}
        </section>

        <section className="mb-5">
          <div className="mb-2 px-1 text-[0.786rem] font-medium uppercase text-text-dimmed">
            Activity
          </div>
          {loading && activeInvocations.length === 0 ? (
            <PanelSkeleton />
          ) : activeInvocations.length === 0 ? (
            <div className="rounded-md border border-border-subtle bg-base/20 px-3 py-2 text-[0.857rem] text-text-placeholder">
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

function PlusIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M6 2.5V9.5" />
      <path d="M2.5 6H9.5" />
    </svg>
  );
}

function InboxIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 15 15"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2.5 8.5 4 3.5h7l1.5 5" />
      <path d="M2.5 8.5h3l.7 1.5h1.6l.7-1.5h3" />
      <path d="M2.5 8.5v2.8a1.2 1.2 0 0 0 1.2 1.2h7.6a1.2 1.2 0 0 0 1.2-1.2V8.5" />
    </svg>
  );
}

function TaskIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 3.5v4.25A2.75 2.75 0 0 0 6.75 10.5H10" />
      <path d="M7.5 6h.75A1.75 1.75 0 0 0 10 4.25V3.5" />
      <circle cx="4" cy="3.5" r="1.25" />
      <circle cx="10" cy="3.5" r="1.25" />
      <circle cx="10" cy="10.5" r="1.25" />
    </svg>
  );
}

function ThreadRow({
  thread,
  active,
  activeCount,
  needsApproval,
  unread,
  onSelect,
}: {
  thread: ConversationThreadPublic;
  active: boolean;
  activeCount: number;
  needsApproval?: boolean;
  unread?: boolean;
  onSelect?: (threadId: string | null) => void;
}) {
  const rowTone = active
    ? "bg-accent/10 text-text"
    : needsApproval
      ? "bg-warning-bg/50 text-text hover:bg-warning-bg/75"
      : "bg-transparent text-text-secondary hover:bg-hover/70 hover:text-text";
  const iconTone = active
    ? "border-accent/35 bg-accent/10 text-accent"
    : needsApproval
      ? "border-warning-text/35 bg-warning-bg text-warning-text"
      : "border-border-subtle bg-raised/60 text-text-dimmed group-hover:text-text-muted";

  return (
    <button
      type="button"
      className={`group relative flex w-full cursor-pointer items-center gap-2.5 px-2.5 py-2.5 text-left transition-colors duration-150 ${rowTone}`}
      onClick={() => onSelect?.(thread.id)}
    >
      <span
        className={`absolute top-2 bottom-2 left-0 w-0.5 rounded-r-sm ${
          active ? "bg-accent" : needsApproval ? "bg-warning-text" : "bg-transparent"
        }`}
        aria-hidden="true"
      />
      <span className={`flex size-7 shrink-0 items-center justify-center rounded border ${iconTone}`}>
        <TaskIcon />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[0.857rem] font-medium">
          {thread.title}
        </span>
        <span className="mt-0.5 text-[0.714rem] text-text-dimmed">
          {formatSessionTime(thread.lastActivityAt)}
        </span>
      </span>
      <ThreadRowBadges
        activeCount={activeCount}
        needsApproval={needsApproval}
        unread={unread}
      />
    </button>
  );
}

function GeneralThreadRow({
  active,
  activeCount,
  needsApproval,
  unread,
  onSelect,
}: {
  active: boolean;
  activeCount: number;
  needsApproval?: boolean;
  unread?: boolean;
  onSelect?: (threadId: string | null) => void;
}) {
  const rowTone = active
    ? "border-accent/45 bg-accent/10 text-text"
    : needsApproval
      ? "border-warning-text/40 bg-warning-bg/55 text-text hover:bg-warning-bg/80"
      : "border-border bg-raised/55 text-text-secondary hover:bg-hover hover:text-text";
  const iconTone = active
    ? "border-accent/35 bg-accent/10 text-accent"
    : needsApproval
      ? "border-warning-text/35 bg-warning-bg text-warning-text"
      : "border-border-subtle bg-base/35 text-text-dimmed";

  return (
    <button
      type="button"
      className={`relative flex w-full cursor-pointer items-center gap-3 rounded-md border px-3 py-3 text-left transition-colors duration-150 ${rowTone}`}
      onClick={() => onSelect?.(null)}
    >
      <span
        className={`absolute top-2 bottom-2 left-0 w-0.5 rounded-r-sm ${
          active ? "bg-accent" : needsApproval ? "bg-warning-text" : "bg-transparent"
        }`}
        aria-hidden="true"
      />
      <span className={`flex size-8 shrink-0 items-center justify-center rounded border ${iconTone}`}>
        <InboxIcon />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[0.929rem] font-semibold">
          General
        </span>
        <span className="mt-0.5 text-[0.714rem] text-text-dimmed">
          Inbox
        </span>
      </span>
      <ThreadRowBadges
        activeCount={activeCount}
        needsApproval={needsApproval}
        unread={unread}
      />
    </button>
  );
}

function ThreadRowBadges({
  activeCount,
  needsApproval,
  unread,
}: {
  activeCount: number;
  needsApproval?: boolean;
  unread?: boolean;
}) {
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      {needsApproval && (
        <span
          className="rounded-full border border-warning-text/40 bg-warning-bg px-2 py-0.5 text-[0.643rem] font-medium uppercase text-warning-text"
          title="Waiting for your approval"
        >
          Review
        </span>
      )}
      {activeCount > 0 && (
        <span className="flex h-5 min-w-5 items-center justify-center rounded-full border border-accent/40 bg-accent/10 px-1.5 text-[0.643rem] font-semibold text-accent">
          {activeCount}
        </span>
      )}
      {unread && !needsApproval && (
        <span
          className="size-1.5 rounded-full bg-accent"
          title="Unread"
          aria-label="Unread"
        />
      )}
    </span>
  );
}

function InvocationRow({ invocation }: { invocation: BotInvocationPublic }) {
  return (
    <div className="rounded-md border border-border-subtle bg-base/20 px-3 py-2">
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
          className="rounded-md border border-border-subtle bg-base/20 px-3 py-2"
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
