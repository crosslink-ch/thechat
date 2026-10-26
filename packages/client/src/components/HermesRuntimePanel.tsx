import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import * as Dialog from "@radix-ui/react-dialog";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { closePalette } from "../CommandPalette";
import type { Command } from "../commands";
import { useScopedCommands } from "../hooks/useScopedCommands";
import { NO_PROJECT_DROP_TARGET, useTaskDrag } from "../hooks/useTaskDrag";
import { useMediaQuery } from "./ResponsiveShell";
import { HeaderAction } from "./HeaderActions";
import {
  ChevronRight,
  Ellipsis,
  Folder,
  FolderInput,
  FolderPlus,
  GitBranch,
  Inbox,
  Pencil,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { OrbLoader } from "./OrbLoader";
import { TaskPanelDialogs, type TaskPanelDialog } from "./TaskProjectDialogs";
import type { TaskGroupSummary } from "../hooks/task-groups-cache";
import {
  buttonClass,
  iconButtonClass,
  menuContentClass,
  menuDangerItemClass,
  menuItemClass,
  menuSeparatorClass,
  sectionLabelClass,
} from "./ui";
import type {
  BotInvocationPublic,
  BotRuntimeSnapshot,
  ConversationThreadPublic,
  TaskProjectPublic,
} from "@thechat/shared";

export function HermesRuntimePanel({
  title = "Hermes",
  botName,
  runtime,
  loading,
  threads = [],
  threadsLoading = false,
  threadGroups = [],
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
  projects = [],
  draftTaskProjectId = null,
  onCreateProject,
  onRenameProject,
  onDeleteProject,
  onMoveThread,
  onDeleteThread,
}: {
  title?: string;
  botName: string;
  runtime: BotRuntimeSnapshot | null;
  loading: boolean;
  threads?: ConversationThreadPublic[];
  threadsLoading?: boolean;
  /**
   * Paging state per task group (project id, or null for tasks without a
   * project). Each group loads its own pages, so a project's count and its
   * "Load more" never depend on tasks elsewhere.
   */
  threadGroups?: TaskGroupSummary[];
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
  /** Starts a draft task, filed under `projectId` when one is given. */
  onCreateThread?: (projectId?: string | null) => void;
  /** Loads the next page of one group: a project id, or null for unfiled tasks. */
  onLoadMoreThreads?: (projectId: string | null) => void;
  projects?: TaskProjectPublic[];
  /** The project the unsaved draft task will be filed under. */
  draftTaskProjectId?: string | null;
  onCreateProject?: (name: string) => Promise<TaskProjectPublic | null>;
  onRenameProject?: (projectId: string, name: string) => Promise<unknown>;
  onDeleteProject?: (projectId: string) => Promise<unknown>;
  onMoveThread?: (threadId: string, projectId: string | null) => Promise<unknown>;
  onDeleteThread?: (threadId: string) => Promise<unknown>;
}) {
  const mobile = useMediaQuery("(max-width: 899px)");
  const [open, setOpen] = useState(false);
  const [editingThreadId, setEditingThreadId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<TaskPanelDialog | null>(null);
  const [collapsedProjectIds, setCollapsedProjectIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [moveError, setMoveError] = useState<string | null>(null);
  const activeThread = threads.find((thread) => thread.id === activeThreadId);
  const canEditActiveTask = !!activeThread && !draftTaskActive;
  // The project the user is working in, used as the default for new tasks.
  const currentProjectId = draftTaskActive
    ? draftTaskProjectId
    : (activeThread?.projectId ?? null);
  const commands = useMemo<Command[]>(() => [
    {
      id: "hermes.rename-task",
      label: "Rename",
      shortcut: null,
      keybinding: null,
      enabled: canEditActiveTask && !!onRenameThread,
      priority: 100,
      execute: () => {
        if (!activeThread || !onRenameThread || draftTaskActive) return;
        closePalette();
        setEditingThreadId(activeThread.id);
        if (mobile) setOpen(true);
      },
    },
    {
      id: "hermes.new-project",
      label: "New Project",
      shortcut: null,
      keybinding: null,
      enabled: !!onCreateProject,
      priority: 100,
      execute: () => {
        closePalette();
        setDialog({ kind: "create-project" });
      },
    },
    {
      id: "hermes.new-task-in-project",
      label: "New Task in Project",
      shortcut: "C-x p n",
      keybinding: { prefix: "C-x p", key: "n" },
      enabled: !!createThread && (projects.length > 0 || !!onCreateProject),
      priority: 100,
      execute: () => {
        closePalette();
        setDialog({ kind: "new-task-in-project", defaultProjectId: currentProjectId });
      },
    },
    {
      id: "hermes.move-task",
      label: "Move Task to Project",
      shortcut: null,
      keybinding: null,
      enabled: canEditActiveTask && !!onMoveThread,
      priority: 100,
      execute: () => {
        if (!activeThread || draftTaskActive) return;
        closePalette();
        setDialog({ kind: "move-task", thread: activeThread });
      },
    },
    {
      id: "hermes.delete-task",
      label: "Delete Task",
      shortcut: null,
      keybinding: null,
      enabled: canEditActiveTask && !!onDeleteThread,
      priority: 100,
      execute: () => {
        if (!activeThread || draftTaskActive) return;
        closePalette();
        setDialog({ kind: "delete-task", thread: activeThread });
      },
    },
  ], [
    activeThread,
    canEditActiveTask,
    createThread,
    currentProjectId,
    draftTaskActive,
    mobile,
    onCreateProject,
    onDeleteThread,
    onMoveThread,
    onRenameThread,
  ]);
  useScopedCommands(commands);
  const moveThreadTo = (threadId: string, projectId: string | null) => {
    const thread = threads.find((item) => item.id === threadId);
    if (!thread || !onMoveThread || (thread.projectId ?? null) === projectId) return;
    setMoveError(null);
    onMoveThread(threadId, projectId).catch((error: unknown) => {
      setMoveError(
        error instanceof Error && error.message
          ? error.message
          : "Could not move the task. Try again.",
      );
    });
  };
  const { drag, dragSourceProps } = useTaskDrag(moveThreadTo);
  const draggable = !mobile && !!onMoveThread && projects.length > 0;
  const projectIds = new Set(projects.map((project) => project.id));
  const tasksByProject = new Map<string | null, ConversationThreadPublic[]>();
  for (const thread of threads) {
    const key = thread.projectId && projectIds.has(thread.projectId) ? thread.projectId : null;
    tasksByProject.set(key, [...(tasksByProject.get(key) ?? []), thread]);
  }
  const groupSummaries = new Map(threadGroups.map((group) => [group.projectId, group]));
  // Tasks of a project the list does not show yet are listed without one.
  const unfiledTotal = threadGroups.reduce<number | null>((sum, group) => {
    if (group.projectId !== null && projectIds.has(group.projectId)) return sum;
    return sum === null || group.totalCount === null ? null : sum + group.totalCount;
  }, 0);
  /** The server's group size when known; never less than what is shown. */
  const groupCount = (total: number | null | undefined, shown: number) =>
    total == null ? shown : Math.max(total, shown);
  const loadMoreButton = (projectId: string | null, label: string) => {
    const group = groupSummaries.get(projectId);
    if (!group?.hasMore || !onLoadMoreThreads) return null;
    return (
      <button
        type="button"
        className={`mt-1 w-full ${buttonClass("ghost", "sm")}`}
        onClick={() => onLoadMoreThreads(projectId)}
        disabled={group.loadingMore}
        aria-label={label ? `Load more tasks ${label}` : "Load more tasks"}
      >
        {group.loadingMore ? "Loading..." : "Load more"}
      </button>
    );
  };
  const draftGroupId =
    draftTaskProjectId && projectIds.has(draftTaskProjectId) ? draftTaskProjectId : null;
  const toggleProject = (projectId: string) =>
    setCollapsedProjectIds((current) => {
      const next = new Set(current);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  useEffect(() => setOpen(false), [mobile, botName]);
  useEffect(() => {
    const dismiss = () => setOpen(false);
    window.addEventListener("popstate", dismiss);
    return () => window.removeEventListener("popstate", dismiss);
  }, []);
  const onSelectThread = selectThread ? (id: string | null) => { setOpen(false); selectThread(id); } : undefined;
  const onCreateThread = createThread
    ? (projectId: string | null = null) => {
        setOpen(false);
        createThread(projectId);
      }
    : undefined;
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

  function renderThreadRow(thread: ConversationThreadPublic) {
    return (
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
        editing={editingThreadId === thread.id}
        onEditingChange={(editing) => setEditingThreadId((current) =>
          editing ? thread.id : current === thread.id ? null : current,
        )}
        dragging={drag?.threadId === thread.id}
        dragSourceProps={draggable ? dragSourceProps(thread.id, thread.title) : undefined}
        onMove={
          onMoveThread && projects.length > 0
            ? () => setDialog({ kind: "move-task", thread })
            : undefined
        }
        onNewProjectFromTask={
          onMoveThread && onCreateProject && projects.length === 0
            ? () => setDialog({ kind: "create-project", moveThreadId: thread.id })
            : undefined
        }
        onDelete={
          onDeleteThread ? () => setDialog({ kind: "delete-task", thread }) : undefined
        }
      />
    );
  }

  const dialogs = (
    <>
      <TaskPanelDialogs
        dialog={dialog}
        projects={projects}
        onClose={() => setDialog(null)}
        onOpen={setDialog}
        onCreateProject={onCreateProject}
        onRenameProject={onRenameProject}
        onDeleteProject={onDeleteProject}
        onMoveThread={onMoveThread}
        onDeleteThread={onDeleteThread}
        onCreateTaskInProject={onCreateThread}
      />
      {drag && (
        <div
          className="pointer-events-none fixed z-50 max-w-[240px] truncate rounded-lg border border-border-accent bg-surface/95 px-2.5 py-1.5 text-[0.857rem] font-medium text-text shadow-card"
          style={{ left: drag.x + 12, top: drag.y + 8 }}
          aria-hidden="true"
        >
          {drag.title}
        </div>
      )}
    </>
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
            <div className="flex shrink-0 items-center gap-0.5">
              {onCreateProject && (
                <button
                  type="button"
                  className={iconButtonClass("md")}
                  onClick={() => setDialog({ kind: "create-project" })}
                  title="New project"
                  aria-label="New project"
                >
                  <FolderPlus size={15} aria-hidden="true" />
                </button>
              )}
              {onCreateThread && (
                <button
                  type="button"
                  className={`shrink-0 ${buttonClass("ghost", "sm")}`}
                  onClick={() => onCreateThread()}
                  title="New task (C-x n)"
                  aria-label="New task"
                >
                  <Plus size={14} aria-hidden="true" />
                  <span>New</span>
                </button>
              )}
            </div>
          </div>
          {moveError && (
            <div
              role="alert"
              className="mb-2 flex items-start gap-2 rounded-lg border border-error-border bg-error-bg px-2.5 py-2 text-[0.786rem] text-error-bright"
            >
              <span className="min-w-0 flex-1">{moveError}</span>
              <button
                type="button"
                className={iconButtonClass("sm")}
                onClick={() => setMoveError(null)}
                aria-label="Dismiss"
              >
                <X size={12} aria-hidden="true" />
              </button>
            </div>
          )}
          {threadsLoading && threads.length === 0 && !draftTaskPresent ? (
            <PanelSkeleton />
          ) : projects.length > 0 ? (
            <div className="flex min-w-0 flex-col gap-2">
              {projects.map((project) => {
                const tasks = tasksByProject.get(project.id) ?? [];
                const draftHere = draftTaskPresent && draftGroupId === project.id;
                const collapsed = collapsedProjectIds.has(project.id);
                return (
                  <ProjectGroup
                    key={project.id}
                    dropTargetId={project.id}
                    dropActive={!!drag && drag.targetId === project.id}
                    name={project.name}
                    count={groupCount(groupSummaries.get(project.id)?.totalCount, tasks.length)}
                    collapsed={collapsed}
                    onToggle={() => toggleProject(project.id)}
                    onCreateTask={
                      onCreateThread ? () => onCreateThread(project.id) : undefined
                    }
                    onRename={
                      onRenameProject
                        ? () => setDialog({ kind: "rename-project", project })
                        : undefined
                    }
                    onDelete={
                      onDeleteProject
                        ? () => setDialog({ kind: "delete-project", project })
                        : undefined
                    }
                  >
                    {!collapsed && (
                      <>
                        {draftHere && (
                          <DraftThreadRow
                            active={draftTaskActive}
                            onSelect={() => onCreateThread?.(draftGroupId)}
                          />
                        )}
                        {tasks.map(renderThreadRow)}
                        {tasks.length === 0 && !draftHere && (
                          <div className="px-2.5 py-1.5 text-[0.786rem] text-text-dimmed">
                            {draggable ? "Drag tasks here" : "No tasks yet"}
                          </div>
                        )}
                        {loadMoreButton(project.id, `in ${project.name}`)}
                      </>
                    )}
                  </ProjectGroup>
                );
              })}
              {(() => {
                const unfiled = tasksByProject.get(null) ?? [];
                const draftHere = draftTaskPresent && draftGroupId === null;
                const count = groupCount(unfiledTotal, unfiled.length);
                if (count === 0 && !draftHere && !drag) return null;
                return (
                  <ProjectGroup
                    dropTargetId={NO_PROJECT_DROP_TARGET}
                    dropActive={!!drag && drag.targetId === NO_PROJECT_DROP_TARGET}
                    name="No project"
                    count={count}
                    unfiled
                  >
                    {draftHere && (
                      <DraftThreadRow
                        active={draftTaskActive}
                        onSelect={() => onCreateThread?.(null)}
                      />
                    )}
                    {unfiled.map(renderThreadRow)}
                    {unfiled.length === 0 && !draftHere && (
                      <div className="px-2.5 py-1.5 text-[0.786rem] text-text-dimmed">
                        Drop here to remove from its project
                      </div>
                    )}
                    {loadMoreButton(null, "without a project")}
                  </ProjectGroup>
                );
              })()}
            </div>
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
                    onSelect={() => onCreateThread?.()}
                  />
                )}
                {threads.map(renderThreadRow)}
              </div>
              {loadMoreButton(null, "")}
            </div>
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
  if (!mobile) return <>{panel}{dialogs}</>;
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
      {dialogs}
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
  editing,
  onEditingChange: setEditing,
  dragging = false,
  dragSourceProps,
  onMove,
  onNewProjectFromTask,
  onDelete,
}: {
  thread: ConversationThreadPublic;
  active: boolean;
  activeCount: number;
  running?: boolean;
  needsApproval?: boolean;
  unread?: boolean;
  onSelect?: (threadId: string | null) => void;
  onRename?: (threadId: string, title: string) => Promise<unknown>;
  editing: boolean;
  onEditingChange: (editing: boolean) => void;
  dragging?: boolean;
  dragSourceProps?: ReturnType<ReturnType<typeof useTaskDrag>["dragSourceProps"]>;
  onMove?: () => void;
  onNewProjectFromTask?: () => void;
  onDelete?: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
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
    if (!editing) setDraftTitle(thread.title);
  }, [thread.title, editing]);

  useEffect(() => {
    if (!editing) return;
    setRenameError(null);
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

  const hasMenu = !!onMove || !!onNewProjectFromTask || !!onDelete;
  return (
    <div
      className={`group relative flex w-full items-center rounded-lg transition-[colors,opacity] duration-150 ${rowTone} ${
        dragging ? "opacity-40" : ""
      }`}
      data-task-row={thread.id}
      {...dragSourceProps}
    >
      <button
        type="button"
        className={`flex min-w-0 flex-1 items-center gap-2.5 px-2.5 py-2 text-left ${
          dragSourceProps ? "cursor-grab active:cursor-grabbing" : "cursor-pointer"
        }`}
        onClick={() => onSelect?.(thread.id)}
        title={dragSourceProps ? "Drag onto a project to move" : undefined}
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
          data-no-task-drag
          aria-label={`Rename ${thread.title}`}
          title="Rename task"
          onClick={() => {
            setDraftTitle(thread.title);
            setRenameError(null);
            setEditing(true);
          }}
          className={`${hasMenu ? "mr-0.5" : "mr-1.5"} ${iconButtonClass("sm")} opacity-0 group-hover:opacity-100 focus:opacity-100 pointer-coarse:opacity-100`}
        >
          <Pencil size={14} aria-hidden="true" />
        </button>
      )}
      {hasMenu && (
        <DropdownMenu.Root open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenu.Trigger asChild>
            <button
              type="button"
              data-no-task-drag
              aria-label={`Task actions for ${thread.title}`}
              title="Task actions"
              className={`mr-1.5 ${iconButtonClass("sm")} ${
                menuOpen ? "bg-hover text-text opacity-100" : "opacity-0 group-hover:opacity-100 focus:opacity-100 pointer-coarse:opacity-100"
              }`}
            >
              <Ellipsis size={14} aria-hidden="true" />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="end"
              sideOffset={4}
              loop
              className={`z-50 ${menuContentClass}`}
            >
              {onMove && (
                <DropdownMenu.Item className={menuItemClass} onSelect={onMove}>
                  <FolderInput size={14} className="text-text-dimmed" aria-hidden="true" />
                  Move to project...
                </DropdownMenu.Item>
              )}
              {onNewProjectFromTask && (
                <DropdownMenu.Item className={menuItemClass} onSelect={onNewProjectFromTask}>
                  <FolderPlus size={14} className="text-text-dimmed" aria-hidden="true" />
                  New project from task...
                </DropdownMenu.Item>
              )}
              {onDelete && (onMove || onNewProjectFromTask) && (
                <DropdownMenu.Separator className={menuSeparatorClass} />
              )}
              {onDelete && (
                <DropdownMenu.Item className={menuDangerItemClass} onSelect={onDelete}>
                  <Trash2 size={14} aria-hidden="true" />
                  Delete task...
                </DropdownMenu.Item>
              )}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      )}
    </div>
  );
}

function ProjectGroup({
  dropTargetId,
  dropActive,
  name,
  count,
  unfiled = false,
  collapsed = false,
  onToggle,
  onCreateTask,
  onRename,
  onDelete,
  children,
}: {
  dropTargetId: string;
  dropActive: boolean;
  name: string;
  count: number;
  unfiled?: boolean;
  collapsed?: boolean;
  onToggle?: () => void;
  onCreateTask?: () => void;
  onRename?: () => void;
  onDelete?: () => void;
  children: ReactNode;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const Icon = unfiled ? Inbox : Folder;
  const hasActions = !!onCreateTask || !!onRename || !!onDelete;
  const label = (
    <>
      {unfiled ? (
        // Keeps the icon and name in the same column as project headers.
        <span className="w-[13px] shrink-0" aria-hidden="true" />
      ) : (
        <ChevronRight
          size={13}
          aria-hidden="true"
          className={`shrink-0 text-text-dimmed transition-transform duration-150 ${
            collapsed ? "" : "rotate-90"
          }`}
        />
      )}
      <Icon size={14} aria-hidden="true" className="shrink-0 text-text-dimmed" />
      <span className="min-w-0 flex-1 truncate">{name}</span>
      <span className="shrink-0 tabular-nums text-[0.714rem] text-text-dimmed">{count}</span>
    </>
  );
  return (
    <div
      role="group"
      aria-label={unfiled ? "Tasks without a project" : `Project ${name}`}
      data-task-drop-target={dropTargetId}
      className={`rounded-lg border transition-colors duration-100 ${
        dropActive ? "border-accent/60 bg-accent/10" : "border-transparent"
      }`}
    >
      <div className="group/project flex items-center gap-0.5 pr-1">
        {onToggle ? (
          <button
            type="button"
            className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[0.857rem] font-medium text-text-secondary hover:text-text"
            onClick={onToggle}
            aria-expanded={!collapsed}
          >
            {label}
          </button>
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-1.5 px-1.5 py-1 text-[0.857rem] font-medium text-text-muted">
            {label}
          </div>
        )}
        {!hasActions && (
          // Occupies the project action buttons' space so task counts share a column.
          <span className="flex shrink-0 gap-0.5" aria-hidden="true">
            <span className="size-6" />
            <span className="size-6" />
          </span>
        )}
        {onCreateTask && (
          <button
            type="button"
            className={`${iconButtonClass("sm")} opacity-0 group-hover/project:opacity-100 focus:opacity-100 pointer-coarse:opacity-100`}
            onClick={onCreateTask}
            aria-label={`New task in ${name}`}
            title="New task in this project"
          >
            <Plus size={13} aria-hidden="true" />
          </button>
        )}
        {(onRename || onDelete) && (
          <DropdownMenu.Root open={menuOpen} onOpenChange={setMenuOpen}>
            <DropdownMenu.Trigger asChild>
              <button
                type="button"
                aria-label={`Project actions for ${name}`}
                title="Project actions"
                className={`${iconButtonClass("sm")} ${
                  menuOpen ? "bg-hover text-text opacity-100" : "opacity-0 group-hover/project:opacity-100 focus:opacity-100 pointer-coarse:opacity-100"
                }`}
              >
                <Ellipsis size={13} aria-hidden="true" />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                align="end"
                sideOffset={4}
                loop
                className={`z-50 ${menuContentClass}`}
              >
                {onRename && (
                  <DropdownMenu.Item className={menuItemClass} onSelect={onRename}>
                    <Pencil size={14} className="text-text-dimmed" aria-hidden="true" />
                    Rename project...
                  </DropdownMenu.Item>
                )}
                {onDelete && (
                  <DropdownMenu.Item className={menuDangerItemClass} onSelect={onDelete}>
                    <Trash2 size={14} aria-hidden="true" />
                    Delete project...
                  </DropdownMenu.Item>
                )}
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        )}
      </div>
      <div className="flex flex-col gap-0.5 pl-2.5">{children}</div>
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
