import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useMediaQuery } from "./ResponsiveShell";
import { HeaderAction } from "./HeaderActions";
import { GitBranch, Inbox, Pencil, Plus, X } from "lucide-react";
import { OrbLoader } from "./OrbLoader";
import { buttonClass, iconButtonClass, sectionLabelClass } from "./ui";
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
  draftTaskActive = false,
  draftTaskPresent = draftTaskActive,
  queuedCountsByThread,
  generalQueuedCount = 0,
  approvalThreadIds,
  generalNeedsApproval = false,
  unreadThreadIds,
  generalUnread = false,
  onSelectThread: selectThread,
  onCreateThread: createThread,
  onRenameThread,
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
  draftTaskActive?: boolean;
  draftTaskPresent?: boolean;
  queuedCountsByThread?: Map<string, number>;
  generalQueuedCount?: number;
  approvalThreadIds?: Set<string>;
  generalNeedsApproval?: boolean;
  unreadThreadIds?: Set<string>;
  generalUnread?: boolean;
  onSelectThread?: (threadId: string | null) => void;
  onRenameThread?: (threadId: string, title: string) => Promise<unknown>;
  onCreateThread?: () => void;
  onLoadMoreThreads?: () => void;
}) {
  const mobile = useMediaQuery("(max-width: 899px)");
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [mobile, botName]);
  useEffect(() => {
    const dismiss = () => setOpen(false);
    window.addEventListener("popstate", dismiss);
    return () => window.removeEventListener("popstate", dismiss);
  }, []);
  const onSelectThread = selectThread ? (id: string | null) => { setOpen(false); selectThread(id); } : undefined;
  const onCreateThread = createThread ? () => { setOpen(false); createThread(); } : undefined;
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
  // Threads with a run in progress show the composing orb.
  const runningThreadIds = new Set(
    activeInvocations
      .filter((invocation) => invocation.status === "running")
      .map((invocation) => invocation.threadId),
  );

  const panel = (
    <aside className="hermes-runtime-panel flex w-80 min-h-0 shrink-0 flex-col border-l border-border bg-surface" aria-label="Hermes tasks and activity">
      <div className="border-b border-border px-4 py-3.5">
        <div className={sectionLabelClass}>{title}</div>
        <div className="mt-0.5 truncate text-[1rem] font-semibold text-text">{botName}</div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4">
        <section className="mb-6">
          <div className={`mb-2 px-1.5 ${sectionLabelClass}`}>
            General
          </div>
          <GeneralThreadRow
            active={activeThreadId === null && !draftTaskActive}
            activeCount={generalActiveCount + generalQueuedCount}
            running={runningThreadIds.has(null)}
            needsApproval={generalNeedsApproval}
            unread={generalUnread && (activeThreadId !== null || draftTaskActive)}
            onSelect={onSelectThread}
          />
        </section>

        <section className="mb-6">
          <div className="mb-2 flex items-center justify-between gap-2 pl-1.5">
            <div className={sectionLabelClass}>
              Tasks
            </div>
            {onCreateThread && (
              <button
                type="button"
                className={`shrink-0 ${buttonClass("ghost", "sm")}`}
                onClick={onCreateThread}
                title="New task (C-x n)"
                aria-label="New task"
              >
                <Plus size={14} aria-hidden="true" />
                <span>New</span>
              </button>
            )}
          </div>
          {threadsLoading && threads.length === 0 && !draftTaskPresent ? (
            <PanelSkeleton />
          ) : threads.length === 0 && !draftTaskPresent ? (
            <div className="rounded-lg border border-dashed border-border px-3 py-3 text-[0.857rem] text-text-dimmed">
              No tasks yet
            </div>
          ) : (
            <div className="min-w-0">
              <div className="flex flex-col gap-0.5">
                {draftTaskPresent && (
                  <DraftThreadRow
                    active={draftTaskActive}
                    onSelect={onCreateThread}
                  />
                )}
                {threads.map((thread) => (
                  <ThreadRow
                    key={thread.id}
                    thread={thread}
                    active={thread.id === activeThreadId}
                    activeCount={
                      (activeCountsByThread.get(thread.id) ?? 0) +
                      (queuedCountsByThread?.get(thread.id) ?? 0)
                    }
                    running={runningThreadIds.has(thread.id)}
                    needsApproval={approvalThreadIds?.has(thread.id) ?? false}
                    unread={
                      thread.id !== activeThreadId &&
                      (unreadThreadIds?.has(thread.id) ?? false)
                    }
                    onSelect={onSelectThread}
                    onRename={onRenameThread}
                  />
                ))}
              </div>
            </div>
          )}
          {threadsHasMore && (
            <button
              type="button"
              className={`mt-2 w-full ${buttonClass("secondary", "sm")}`}
              onClick={onLoadMoreThreads}
              disabled={threadsLoadingMore}
            >
              {threadsLoadingMore ? "Loading..." : "Load more"}
            </button>
          )}
        </section>

        <section className="mb-5">
          <div className={`mb-2 px-1.5 ${sectionLabelClass}`}>
            Activity
          </div>
          {loading && activeInvocations.length === 0 ? (
            <PanelSkeleton />
          ) : activeInvocations.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border px-3 py-2.5 text-[0.857rem] text-text-dimmed">
              No active runs
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {activeInvocations.map((invocation) => (
                <InvocationRow
                  key={invocation.id}
                  invocation={invocation}
                  waiting={
                    invocation.threadId === null
                      ? generalNeedsApproval
                      : (approvalThreadIds?.has(invocation.threadId) ?? false)
                  }
                />
              ))}
            </div>
          )}
        </section>
      </div>
    </aside>
  );
  if (!mobile) return panel;
  const approvalSuffix = generalNeedsApproval || (approvalThreadIds?.size ?? 0) > 0 ? " · Needs approval" : "";
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <HeaderAction>
        <Dialog.Trigger className="mobile-touch-button px-2 text-[0.857rem] whitespace-nowrap" aria-label={`Open tasks and activity${approvalSuffix}`}>
          Tasks{approvalSuffix}
        </Dialog.Trigger>
      </HeaderAction>
      <Dialog.Portal>
        <Dialog.Overlay className="mobile-drawer-overlay" />
        <Dialog.Content className="mobile-drawer mobile-task-drawer" aria-describedby={undefined}>
          <div className="mobile-drawer-heading">
            <Dialog.Title>Tasks and activity</Dialog.Title>
            <Dialog.Close className="mobile-touch-button" aria-label="Close tasks and activity"><X size={18} aria-hidden="true" /></Dialog.Close>
          </div>
          {panel}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function ThreadRow({
  thread,
  active,
  activeCount,
  running = false,
  needsApproval,
  unread,
  onSelect,
  onRename,
}: {
  thread: ConversationThreadPublic;
  active: boolean;
  activeCount: number;
  running?: boolean;
  needsApproval?: boolean;
  unread?: boolean;
  onSelect?: (threadId: string | null) => void;
  onRename?: (threadId: string, title: string) => Promise<unknown>;
}) {
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState(thread.title);
  const [saving, setSaving] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const renameButtonRef = useRef<HTMLButtonElement>(null);
  const restoreRenameFocusRef = useRef(false);
  const rowTone = active
    ? "bg-accent/10 text-text"
    : needsApproval
      ? "bg-warning-bg/60 text-text hover:bg-warning-bg"
      : "bg-transparent text-text-secondary hover:bg-hover hover:text-text";
  const iconTone = active
    ? "border-accent/30 bg-accent/10 text-accent"
    : needsApproval
      ? "border-warning/30 bg-warning-bg text-warning-text"
      : "border-border-subtle bg-raised text-text-dimmed group-hover:text-text-muted";

  useEffect(() => {
    if (!editing) return;
    renameInputRef.current?.focus();
    renameInputRef.current?.select();
  }, [editing]);

  useEffect(() => {
    if (editing || !restoreRenameFocusRef.current) return;
    restoreRenameFocusRef.current = false;
    renameButtonRef.current?.focus();
  }, [editing]);

  const closeRenameEditor = () => {
    restoreRenameFocusRef.current = true;
    setEditing(false);
  };

  const cancelRename = () => {
    closeRenameEditor();
    setDraftTitle(thread.title);
    setRenameError(null);
  };

  const handleRenameSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const title = draftTitle.trim();
    if (!title) {
      setRenameError("Enter a task name.");
      return;
    }
    if (title === thread.title) {
      cancelRename();
      return;
    }
    if (!onRename || saving) return;

    setSaving(true);
    setRenameError(null);
    try {
      await onRename(thread.id, title);
      closeRenameEditor();
    } catch {
      setRenameError("Could not rename task. Try again.");
    } finally {
      setSaving(false);
    }
  };

  const handleRenameKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    cancelRename();
  };

  if (editing) {
    return (
      <form
        className={`group relative flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left ${rowTone}`}
        onSubmit={handleRenameSubmit}
      >
        <span
          className={`absolute top-2.5 bottom-2.5 left-0 w-0.5 rounded-full ${
            active ? "bg-accent" : needsApproval ? "bg-warning-text" : "bg-transparent"
          }`}
          aria-hidden="true"
        />
        <span className={`flex size-7 shrink-0 items-center justify-center rounded-md border ${iconTone}`}>
          <GitBranch size={14} aria-hidden="true" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <input
            ref={renameInputRef}
            aria-label="Task name"
            maxLength={255}
            value={draftTitle}
            onChange={(event) => {
              setDraftTitle(event.target.value);
              setRenameError(null);
            }}
            onKeyDown={handleRenameKeyDown}
            disabled={saving}
            className="h-7 min-w-0 rounded-md border border-accent/45 bg-base px-2 text-[0.857rem] text-text outline-none transition-[border-color,box-shadow] duration-150 focus:border-accent/60 focus:ring-3 focus:ring-accent/15 disabled:opacity-60"
          />
          {renameError && (
            <span role="alert" className="text-[0.714rem] text-error-bright">
              {renameError}
            </span>
          )}
        </span>
        <button
          type="submit"
          disabled={saving}
          className={buttonClass("primary", "sm")}
        >
          {saving ? "Saving..." : "Save"}
        </button>
        <button
          type="button"
          onClick={cancelRename}
          disabled={saving}
          className={buttonClass("ghost", "sm")}
        >
          Cancel
        </button>
      </form>
    );
  }

  return (
    <div
      className={`group relative flex w-full items-center rounded-lg transition-colors duration-150 ${rowTone}`}
    >
      <button
        type="button"
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 px-2.5 py-2 text-left"
        onClick={() => onSelect?.(thread.id)}
      >
        <span
          className={`absolute top-2.5 bottom-2.5 left-0 w-0.5 rounded-full ${
            active ? "bg-accent" : needsApproval ? "bg-warning-text" : "bg-transparent"
          }`}
          aria-hidden="true"
        />
        <span className={`flex size-7 shrink-0 items-center justify-center rounded-md border ${iconTone}`}>
          {running && !needsApproval ? (
            <OrbLoader state="composing" size={20} />
          ) : (
            <GitBranch size={14} aria-hidden="true" />
          )}
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
      {onRename && (
        <button
          ref={renameButtonRef}
          type="button"
          aria-label={`Rename ${thread.title}`}
          title="Rename task"
          onClick={() => {
            setDraftTitle(thread.title);
            setRenameError(null);
            setEditing(true);
          }}
          className={`mr-1.5 ${iconButtonClass("sm")} opacity-0 group-hover:opacity-100 focus:opacity-100`}
        >
          <Pencil size={14} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

function DraftThreadRow({
  active,
  onSelect,
}: {
  active: boolean;
  onSelect?: () => void;
}) {
  return (
    <button
      type="button"
      className={`group relative flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors duration-150 ${
        active
          ? "bg-accent/10 text-text"
          : "bg-transparent text-text-secondary hover:bg-hover hover:text-text"
      }`}
      onClick={onSelect}
      data-testid="hermes-local-task-draft"
      aria-current={active ? "true" : undefined}
    >
      <span
        className={`absolute top-2.5 bottom-2.5 left-0 w-0.5 rounded-full ${
          active ? "bg-accent" : "bg-transparent"
        }`}
        aria-hidden="true"
      />
      <span
        className={`flex size-7 shrink-0 items-center justify-center rounded-md border ${
          active
            ? "border-accent/30 bg-accent/10 text-accent"
            : "border-border-subtle bg-raised text-text-dimmed group-hover:text-text-muted"
        }`}
      >
        <GitBranch size={14} aria-hidden="true" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[0.857rem] font-medium">New task</span>
        <span className="mt-0.5 text-[0.714rem] text-text-dimmed">Draft, not saved</span>
      </span>
    </button>
  );
}

function GeneralThreadRow({
  active,
  activeCount,
  running = false,
  needsApproval,
  unread,
  onSelect,
}: {
  active: boolean;
  activeCount: number;
  running?: boolean;
  needsApproval?: boolean;
  unread?: boolean;
  onSelect?: (threadId: string | null) => void;
}) {
  const rowTone = active
    ? "border-border-accent bg-accent/10 text-text"
    : needsApproval
      ? "border-warning/30 bg-warning-bg/60 text-text hover:bg-warning-bg"
      : "border-border bg-raised text-text-secondary hover:bg-hover hover:text-text";
  const iconTone = active
    ? "border-accent/30 bg-accent/10 text-accent"
    : needsApproval
      ? "border-warning/30 bg-warning-bg text-warning-text"
      : "border-border-subtle bg-elevated/60 text-text-dimmed";

  return (
    <button
      type="button"
      className={`relative flex w-full cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors duration-150 ${rowTone}`}
      onClick={() => onSelect?.(null)}
    >
      <span
        className={`absolute top-2.5 bottom-2.5 left-0 w-0.5 rounded-full ${
          active ? "bg-accent" : needsApproval ? "bg-warning-text" : "bg-transparent"
        }`}
        aria-hidden="true"
      />
      <span className={`flex size-8 shrink-0 items-center justify-center rounded-md border ${iconTone}`}>
        {running && !needsApproval ? (
          <OrbLoader state="composing" size={22} />
        ) : (
          <Inbox size={16} aria-hidden="true" />
        )}
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
          className="rounded-full border border-warning/30 bg-warning-bg px-2 py-0.5 text-[0.643rem] font-medium uppercase text-warning-text"
          title="Waiting for your approval"
        >
          Review
        </span>
      )}
      {activeCount > 0 && (
        <span className="flex h-5 min-w-5 items-center justify-center rounded-full border border-border-accent bg-accent/15 px-1.5 text-[0.714rem] font-semibold tabular-nums text-accent">
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

function InvocationRow({
  invocation,
  waiting,
}: {
  invocation: BotInvocationPublic;
  /** Paused on an approval, so not animated as working. */
  waiting: boolean;
}) {
  return (
    <div className="rounded-lg border border-border-subtle bg-raised px-3 py-2.5">
      <div className="flex items-start justify-between gap-2">
        {invocation.status === "running" && !waiting && (
          <OrbLoader state="composing" size={18} className="-my-px shrink-0" />
        )}
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
          className="rounded-lg border border-border-subtle bg-raised px-3 py-2.5"
        >
          <div className="flex items-start justify-between gap-2">
            <div className="h-3 w-28 animate-pulse rounded-sm bg-elevated" />
            <div className="h-4 w-12 animate-pulse rounded-full bg-elevated" />
          </div>
          <div className="mt-2 h-2.5 w-24 animate-pulse rounded-sm bg-elevated" />
          <div className="mt-3 h-2.5 w-full animate-pulse rounded-sm bg-elevated" />
        </div>
      ))}
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const tone =
    status === "completed"
      ? "border-success-border bg-success-bg text-success-light"
      : status === "failed"
        ? "border-error-border bg-error-bg text-error-bright"
        : status === "cancelled"
          ? "border-border bg-elevated text-text-muted"
          : status === "running"
            ? "border-border-accent bg-accent/10 text-accent"
            : "border-border bg-elevated text-text-muted";
  return (
    <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[0.643rem] font-medium uppercase ${tone}`}>
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
