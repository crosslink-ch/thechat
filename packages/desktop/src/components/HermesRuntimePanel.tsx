import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  useEffect,
  useMemo,
  useState,
  type DragEvent,
  type FormEvent,
} from "react";
import type {
  BotInvocationPublic,
  BotRuntimeSnapshot,
  ConversationThreadPublic,
} from "@thechat/shared";
import {
  HERMES_TASK_PROJECT_COLORS,
  useHermesTaskProjects,
  type HermesTaskProject,
  type HermesTaskProjectColor,
} from "../hooks/useHermesTaskProjects";

const UNFILED_PROJECT_ID = "__unfiled__";

const PROJECT_COLOR_STYLES: Record<
  HermesTaskProjectColor,
  { dot: string; soft: string; ring: string }
> = {
  blue: {
    dot: "bg-blue-400",
    soft: "bg-blue-400/10",
    ring: "ring-blue-400/35",
  },
  violet: {
    dot: "bg-violet-400",
    soft: "bg-violet-400/10",
    ring: "ring-violet-400/35",
  },
  emerald: {
    dot: "bg-emerald-400",
    soft: "bg-emerald-400/10",
    ring: "ring-emerald-400/35",
  },
  amber: {
    dot: "bg-amber-400",
    soft: "bg-amber-400/10",
    ring: "ring-amber-400/35",
  },
  rose: {
    dot: "bg-rose-400",
    soft: "bg-rose-400/10",
    ring: "ring-rose-400/35",
  },
  cyan: {
    dot: "bg-cyan-400",
    soft: "bg-cyan-400/10",
    ring: "ring-cyan-400/35",
  },
};

const PROJECT_COLOR_LABELS: Record<HermesTaskProjectColor, string> = {
  blue: "Blue",
  violet: "Violet",
  emerald: "Emerald",
  amber: "Amber",
  rose: "Rose",
  cyan: "Cyan",
};

type ProjectEditorState =
  | { mode: "create" }
  | { mode: "edit"; projectId: string }
  | null;

export function HermesRuntimePanel({
  title = "Hermes",
  botName,
  runtime,
  loading,
  userId = null,
  conversationId = null,
  threads = [],
  threadsLoading = false,
  threadsLoadingMore = false,
  threadsHasMore = false,
  activeThreadId = null,
  draftTaskActive = false,
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
  userId?: string | null;
  conversationId?: string | null;
  threads?: ConversationThreadPublic[];
  threadsLoading?: boolean;
  threadsLoadingMore?: boolean;
  threadsHasMore?: boolean;
  activeThreadId?: string | null;
  draftTaskActive?: boolean;
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
    () =>
      (runtime?.invocations ?? []).filter(
        (invocation) => invocation.botKind === "hermes",
      ),
    [runtime],
  );
  const progressInvocationIds = new Set(
    (runtime?.events ?? []).map((event) => event.invocationId),
  );
  const activeInvocations = invocations.filter(
    (invocation) =>
      invocation.status === "queued" ||
      progressInvocationIds.has(invocation.id),
  );
  const activeCountsByThread = useMemo(() => {
    const counts = new Map<string, number>();
    for (const invocation of activeInvocations) {
      if (!invocation.threadId) continue;
      counts.set(
        invocation.threadId,
        (counts.get(invocation.threadId) ?? 0) + 1,
      );
    }
    return counts;
  }, [activeInvocations]);
  const generalActiveCount = activeInvocations.filter(
    (invocation) => invocation.threadId === null,
  ).length;

  const taskProjects = useHermesTaskProjects({ userId, conversationId });
  const [projectEditor, setProjectEditor] = useState<ProjectEditorState>(null);
  const [projectPendingDelete, setProjectPendingDelete] = useState<
    string | null
  >(null);
  const [collapsedProjectIds, setCollapsedProjectIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [draggedThreadId, setDraggedThreadId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);

  useEffect(() => {
    setProjectEditor(null);
    setProjectPendingDelete(null);
    setCollapsedProjectIds(new Set());
    setDraggedThreadId(null);
    setDropTargetId(null);
  }, [conversationId, userId]);

  const validProjectIds = useMemo(
    () => new Set(taskProjects.projects.map((project) => project.id)),
    [taskProjects.projects],
  );
  const unfiledThreads = useMemo(
    () =>
      threads.filter((thread) => {
        const assignedProjectId = taskProjects.assignments[thread.id];
        return !assignedProjectId || !validProjectIds.has(assignedProjectId);
      }),
    [taskProjects.assignments, threads, validProjectIds],
  );
  const threadsByProject = useMemo(() => {
    const grouped = new Map<string, ConversationThreadPublic[]>();
    for (const project of taskProjects.projects) grouped.set(project.id, []);
    for (const thread of threads) {
      const assignedProjectId = taskProjects.assignments[thread.id];
      grouped.get(assignedProjectId)?.push(thread);
    }
    return grouped;
  }, [taskProjects.assignments, taskProjects.projects, threads]);

  const localProjectsAvailable = Boolean(userId && conversationId);
  const showProjectGroups = taskProjects.projects.length > 0;
  const taskListLoading =
    (threadsLoading && threads.length === 0 && !draftTaskActive) ||
    (localProjectsAvailable && taskProjects.loading && threads.length > 0);

  const toggleProject = (projectId: string) => {
    setCollapsedProjectIds((current) => {
      const next = new Set(current);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  };

  const handleAssignTask = async (
    threadId: string,
    projectId: string | null,
  ) => {
    try {
      await taskProjects.assignTask(threadId, projectId);
    } catch {
      // The hook keeps the actionable error visible in the panel.
    } finally {
      setDraggedThreadId(null);
      setDropTargetId(null);
    }
  };

  const handleCreateProject = async (
    name: string,
    color: HermesTaskProjectColor,
  ) => {
    const project = await taskProjects.createProject(name, color);
    setCollapsedProjectIds((current) => {
      const next = new Set(current);
      next.delete(project.id);
      return next;
    });
    setProjectEditor(null);
  };

  const handleUpdateProject = async (
    projectId: string,
    name: string,
    color: HermesTaskProjectColor,
  ) => {
    await taskProjects.updateProject(projectId, name, color);
    setProjectEditor(null);
  };

  const handleDeleteProject = async (projectId: string) => {
    try {
      await taskProjects.deleteProject(projectId);
      setProjectPendingDelete(null);
      if (
        projectEditor?.mode === "edit" &&
        projectEditor.projectId === projectId
      ) {
        setProjectEditor(null);
      }
    } catch {
      // The hook keeps the actionable error visible in the panel.
    }
  };

  const editingProject =
    projectEditor?.mode === "edit"
      ? taskProjects.projects.find(
          (project) => project.id === projectEditor.projectId,
        )
      : null;

  return (
    <aside className="hidden w-80 shrink-0 flex-col border-l border-border bg-surface/80 lg:flex">
      <div className="border-b border-border px-4 py-3.5">
        <div className="text-[0.786rem] font-medium uppercase text-text-dimmed">
          {title}
        </div>
        <div className="truncate text-[1rem] font-semibold text-text">
          {botName}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3.5 py-4">
        <section className="mb-5">
          <div className="mb-2 px-1 text-[0.786rem] font-medium uppercase text-text-dimmed">
            General
          </div>
          <GeneralThreadRow
            active={activeThreadId === null && !draftTaskActive}
            activeCount={generalActiveCount + generalQueuedCount}
            needsApproval={generalNeedsApproval}
            unread={
              generalUnread && (activeThreadId !== null || draftTaskActive)
            }
            onSelect={onSelectThread}
          />
        </section>

        <section className="mb-5">
          <div className="mb-2 flex items-center justify-between gap-2 px-1">
            <div className="text-[0.786rem] font-medium uppercase text-text-dimmed">
              Tasks
            </div>
            <div className="flex items-center gap-1.5">
              {localProjectsAvailable && (
                <button
                  type="button"
                  className="flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-md border border-border bg-raised/45 px-2 text-[0.75rem] font-medium text-text-muted transition-colors duration-150 hover:border-border-strong hover:bg-hover hover:text-text disabled:cursor-default disabled:opacity-45"
                  onClick={() => {
                    taskProjects.clearError();
                    setProjectPendingDelete(null);
                    setProjectEditor({ mode: "create" });
                  }}
                  disabled={taskProjects.saving}
                  title="Create a project saved on this device"
                  aria-label="New project"
                >
                  <FolderPlusIcon className="size-3.5" />
                  <span>Project</span>
                </button>
              )}
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
          </div>

          {projectEditor?.mode === "create" && (
            <div className="mb-2">
              <ProjectEditor
                mode="create"
                saving={taskProjects.saving}
                onSubmit={handleCreateProject}
                onCancel={() => {
                  taskProjects.clearError();
                  setProjectEditor(null);
                }}
              />
            </div>
          )}

          {taskProjects.error && (
            <div
              role="alert"
              className="mb-2 rounded-md border border-error-border bg-error-bg px-2.5 py-2 text-[0.75rem] text-error-bright"
            >
              <div>{taskProjects.error}</div>
              <button
                type="button"
                className="mt-1 cursor-pointer font-medium underline underline-offset-2"
                onClick={() => void taskProjects.reload()}
              >
                Retry local storage
              </button>
            </div>
          )}

          {taskListLoading ? (
            <PanelSkeleton />
          ) : threads.length === 0 && !draftTaskActive ? (
            <div className="rounded-md border border-dashed border-border-subtle bg-base/20 px-3 py-3 text-[0.857rem] text-text-placeholder">
              No tasks yet
            </div>
          ) : showProjectGroups ? (
            <div className="space-y-2">
              <TaskProjectGroup
                project={null}
                threads={unfiledThreads}
                draftTaskActive={draftTaskActive}
                activeThreadId={activeThreadId}
                activeCountsByThread={activeCountsByThread}
                queuedCountsByThread={queuedCountsByThread}
                approvalThreadIds={approvalThreadIds}
                unreadThreadIds={unreadThreadIds}
                projects={taskProjects.projects}
                assignments={taskProjects.assignments}
                collapsed={collapsedProjectIds.has(UNFILED_PROJECT_ID)}
                saving={taskProjects.saving}
                dropTargetId={dropTargetId}
                onToggle={() => toggleProject(UNFILED_PROJECT_ID)}
                onSelectThread={onSelectThread}
                onSelectDraft={onCreateThread}
                onAssignTask={handleAssignTask}
                onDragStart={setDraggedThreadId}
                onDragEnd={() => {
                  setDraggedThreadId(null);
                  setDropTargetId(null);
                }}
                onDragOver={setDropTargetId}
                draggedThreadId={draggedThreadId}
              />
              {taskProjects.projects.map((project) => (
                <TaskProjectGroup
                  key={project.id}
                  project={project}
                  threads={threadsByProject.get(project.id) ?? []}
                  draftTaskActive={false}
                  activeThreadId={activeThreadId}
                  activeCountsByThread={activeCountsByThread}
                  queuedCountsByThread={queuedCountsByThread}
                  approvalThreadIds={approvalThreadIds}
                  unreadThreadIds={unreadThreadIds}
                  projects={taskProjects.projects}
                  assignments={taskProjects.assignments}
                  collapsed={collapsedProjectIds.has(project.id)}
                  saving={taskProjects.saving}
                  dropTargetId={dropTargetId}
                  onToggle={() => toggleProject(project.id)}
                  onSelectThread={onSelectThread}
                  onAssignTask={handleAssignTask}
                  onDragStart={setDraggedThreadId}
                  onDragEnd={() => {
                    setDraggedThreadId(null);
                    setDropTargetId(null);
                  }}
                  onDragOver={setDropTargetId}
                  draggedThreadId={draggedThreadId}
                  onEdit={() => {
                    taskProjects.clearError();
                    setProjectPendingDelete(null);
                    setProjectEditor({ mode: "edit", projectId: project.id });
                  }}
                  onRequestDelete={() => {
                    taskProjects.clearError();
                    setProjectEditor(null);
                    setProjectPendingDelete(project.id);
                  }}
                  editor={
                    editingProject?.id === project.id ? (
                      <ProjectEditor
                        mode="edit"
                        initialName={editingProject.name}
                        initialColor={editingProject.color}
                        saving={taskProjects.saving}
                        onSubmit={(name, color) =>
                          handleUpdateProject(project.id, name, color)
                        }
                        onCancel={() => {
                          taskProjects.clearError();
                          setProjectEditor(null);
                        }}
                      />
                    ) : null
                  }
                  deleteConfirmation={
                    projectPendingDelete === project.id ? (
                      <ProjectDeleteConfirmation
                        projectName={project.name}
                        saving={taskProjects.saving}
                        onCancel={() => setProjectPendingDelete(null)}
                        onConfirm={() => void handleDeleteProject(project.id)}
                      />
                    ) : null
                  }
                />
              ))}
            </div>
          ) : (
            <div className="overflow-hidden rounded-md border border-border-subtle bg-base/20">
              <div className="divide-y divide-border-subtle">
                {draftTaskActive && (
                  <DraftThreadRow onSelect={onCreateThread} />
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
                    needsApproval={approvalThreadIds?.has(thread.id) ?? false}
                    unread={
                      thread.id !== activeThreadId &&
                      (unreadThreadIds?.has(thread.id) ?? false)
                    }
                    projects={[]}
                    assignedProjectId={null}
                    saving={taskProjects.saving}
                    onSelect={onSelectThread}
                    onAssign={handleAssignTask}
                    onDragStart={setDraggedThreadId}
                    onDragEnd={() => {
                      setDraggedThreadId(null);
                      setDropTargetId(null);
                    }}
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

function TaskProjectGroup({
  project,
  threads,
  draftTaskActive,
  activeThreadId,
  activeCountsByThread,
  queuedCountsByThread,
  approvalThreadIds,
  unreadThreadIds,
  projects,
  assignments,
  collapsed,
  saving,
  dropTargetId,
  draggedThreadId,
  editor,
  deleteConfirmation,
  onToggle,
  onSelectThread,
  onSelectDraft,
  onAssignTask,
  onDragStart,
  onDragEnd,
  onDragOver,
  onEdit,
  onRequestDelete,
}: {
  project: HermesTaskProject | null;
  threads: ConversationThreadPublic[];
  draftTaskActive: boolean;
  activeThreadId: string | null;
  activeCountsByThread: Map<string, number>;
  queuedCountsByThread?: Map<string, number>;
  approvalThreadIds?: Set<string>;
  unreadThreadIds?: Set<string>;
  projects: HermesTaskProject[];
  assignments: Record<string, string>;
  collapsed: boolean;
  saving: boolean;
  dropTargetId: string | null;
  draggedThreadId: string | null;
  editor?: React.ReactNode;
  deleteConfirmation?: React.ReactNode;
  onToggle: () => void;
  onSelectThread?: (threadId: string | null) => void;
  onSelectDraft?: () => void;
  onAssignTask: (threadId: string, projectId: string | null) => Promise<void>;
  onDragStart: (threadId: string) => void;
  onDragEnd: () => void;
  onDragOver: (projectId: string | null) => void;
  onEdit?: () => void;
  onRequestDelete?: () => void;
}) {
  const projectId = project?.id ?? null;
  const targetId = projectId ?? UNFILED_PROJECT_ID;
  const count = threads.length + (draftTaskActive ? 1 : 0);
  const isDropTarget = dropTargetId === targetId && Boolean(draggedThreadId);
  const colors = project ? PROJECT_COLOR_STYLES[project.color] : null;

  const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!draggedThreadId && !event.dataTransfer.types?.length) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    onDragOver(projectId);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const threadId =
      event.dataTransfer.getData("application/x-thechat-thread") ||
      event.dataTransfer.getData("text/plain") ||
      draggedThreadId;
    onDragOver(null);
    if (threadId) void onAssignTask(threadId, projectId);
  };

  return (
    <div
      data-testid={`hermes-project-${project?.id ?? "unfiled"}`}
      className={`overflow-hidden rounded-lg border bg-base/20 transition-colors duration-150 ${
        isDropTarget
          ? "border-accent/65 bg-accent/8 shadow-[inset_0_0_0_1px_rgb(var(--accent)/0.18)]"
          : "border-border-subtle"
      }`}
      onDragOver={handleDragOver}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          onDragOver(null);
        }
      }}
      onDrop={handleDrop}
    >
      <div className="flex min-h-9 items-center border-b border-border-subtle bg-raised/35 px-1.5">
        <button
          type="button"
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded px-1.5 py-1.5 text-left text-[0.786rem] font-medium text-text-muted hover:text-text"
          onClick={onToggle}
          aria-expanded={!collapsed}
        >
          <ChevronIcon
            className={`size-3 shrink-0 transition-transform ${collapsed ? "-rotate-90" : ""}`}
          />
          {project ? (
            <span
              className={`flex size-5 shrink-0 items-center justify-center rounded ${colors?.soft}`}
            >
              <FolderIcon className="size-3.5" />
            </span>
          ) : (
            <span className="flex size-5 shrink-0 items-center justify-center rounded bg-raised text-text-dimmed">
              <InboxSmallIcon className="size-3.5" />
            </span>
          )}
          {project && (
            <span className={`size-1.5 shrink-0 rounded-full ${colors?.dot}`} />
          )}
          <span className="truncate">{project?.name ?? "Unfiled"}</span>
          <span className="ml-auto flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-raised px-1 text-[0.643rem] font-medium text-text-dimmed">
            {count}
          </span>
        </button>
        {project && (
          <ProjectActions
            project={project}
            disabled={saving}
            onEdit={onEdit}
            onDelete={onRequestDelete}
          />
        )}
      </div>

      {editor && (
        <div className="border-b border-border-subtle p-2">{editor}</div>
      )}
      {deleteConfirmation && (
        <div className="border-b border-border-subtle p-2">
          {deleteConfirmation}
        </div>
      )}

      {!collapsed && (
        <div className="divide-y divide-border-subtle">
          {draftTaskActive && <DraftThreadRow onSelect={onSelectDraft} />}
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
              projects={projects}
              assignedProjectId={assignments[thread.id] ?? null}
              saving={saving}
              onSelect={onSelectThread}
              onAssign={onAssignTask}
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
            />
          ))}
          {threads.length === 0 && !draftTaskActive && (
            <div className="m-2 rounded border border-dashed border-border-subtle px-2 py-2 text-center text-[0.714rem] text-text-placeholder">
              {isDropTarget ? "Release to move task" : "Drop tasks here"}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ProjectEditor({
  mode,
  initialName = "",
  initialColor = "blue",
  saving,
  onSubmit,
  onCancel,
}: {
  mode: "create" | "edit";
  initialName?: string;
  initialColor?: HermesTaskProjectColor;
  saving: boolean;
  onSubmit: (name: string, color: HermesTaskProjectColor) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [color, setColor] = useState<HermesTaskProjectColor>(initialColor);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalizedName = name.trim();
    if (!normalizedName || saving) return;
    try {
      await onSubmit(normalizedName, color);
    } catch {
      // The project hook exposes the local persistence error above the list.
    }
  };

  return (
    <form
      className="rounded-md border border-border bg-raised/55 p-2.5 shadow-sm"
      onSubmit={handleSubmit}
    >
      <label htmlFor={`hermes-project-name-${mode}`} className="sr-only">
        Project name
      </label>
      <input
        id={`hermes-project-name-${mode}`}
        autoFocus
        maxLength={80}
        value={name}
        onChange={(event) => setName(event.target.value)}
        placeholder="Project name"
        className="h-8 w-full rounded-md border border-border bg-background px-2.5 text-[0.786rem] text-text outline-none placeholder:text-text-placeholder focus:border-accent/60 focus:ring-1 focus:ring-accent/25"
      />
      <div className="mt-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1" aria-label="Project color">
          {HERMES_TASK_PROJECT_COLORS.map((candidate) => {
            const style = PROJECT_COLOR_STYLES[candidate];
            return (
              <button
                key={candidate}
                type="button"
                className={`flex size-6 cursor-pointer items-center justify-center rounded-full transition hover:bg-hover ${
                  color === candidate ? `ring-2 ${style.ring}` : ""
                }`}
                onClick={() => setColor(candidate)}
                aria-label={`Use ${PROJECT_COLOR_LABELS[candidate]}`}
                aria-pressed={color === candidate}
              >
                <span className={`size-2.5 rounded-full ${style.dot}`} />
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            className="h-7 cursor-pointer rounded px-2 text-[0.714rem] font-medium text-text-muted hover:bg-hover hover:text-text"
            onClick={onCancel}
            disabled={saving}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="h-7 cursor-pointer rounded-md bg-accent px-2.5 text-[0.714rem] font-semibold text-on-accent transition hover:brightness-110 disabled:cursor-default disabled:opacity-45"
            disabled={!name.trim() || saving}
          >
            {saving
              ? "Saving..."
              : mode === "create"
                ? "Create project"
                : "Save project"}
          </button>
        </div>
      </div>
      {mode === "create" && (
        <div className="mt-2 flex items-center gap-1.5 text-[0.643rem] text-text-dimmed">
          <DeviceIcon className="size-3" />
          <span>Saved only on this device</span>
        </div>
      )}
    </form>
  );
}

function ProjectDeleteConfirmation({
  projectName,
  saving,
  onCancel,
  onConfirm,
}: {
  projectName: string;
  saving: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      role="alertdialog"
      aria-label={`Delete ${projectName}`}
      className="rounded-md border border-error-border bg-error-bg p-2.5"
    >
      <div className="text-[0.786rem] font-semibold text-error-bright">
        Delete {projectName}?
      </div>
      <div className="mt-0.5 text-[0.714rem] text-text-muted">
        Tasks will become unfiled. Nothing is deleted from the conversation.
      </div>
      <div className="mt-2 flex justify-end gap-1.5">
        <button
          type="button"
          className="h-7 cursor-pointer rounded px-2 text-[0.714rem] font-medium text-text-muted hover:bg-hover"
          onClick={onCancel}
          disabled={saving}
        >
          Cancel
        </button>
        <button
          type="button"
          className="h-7 cursor-pointer rounded-md border border-error-border bg-error px-2.5 text-[0.714rem] font-semibold text-white hover:brightness-110 disabled:cursor-default disabled:opacity-45"
          onClick={onConfirm}
          disabled={saving}
        >
          {saving ? "Deleting..." : "Delete project"}
        </button>
      </div>
    </div>
  );
}

function ProjectActions({
  project,
  disabled,
  onEdit,
  onDelete,
}: {
  project: HermesTaskProject;
  disabled: boolean;
  onEdit?: () => void;
  onDelete?: () => void;
}) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded text-text-dimmed hover:bg-hover hover:text-text disabled:cursor-default disabled:opacity-40"
          aria-label={`Project actions for ${project.name}`}
          disabled={disabled}
        >
          <MoreIcon className="size-4" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side="left"
          align="start"
          sideOffset={6}
          className="z-50 min-w-40 rounded-md border border-border bg-surface p-1 shadow-xl"
        >
          <DropdownMenu.Item
            className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[0.786rem] text-text-secondary outline-none data-[highlighted]:bg-hover data-[highlighted]:text-text"
            onSelect={onEdit}
          >
            <PencilIcon className="size-3.5" />
            Edit project
          </DropdownMenu.Item>
          <DropdownMenu.Separator className="my-1 h-px bg-border-subtle" />
          <DropdownMenu.Item
            className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[0.786rem] text-error-bright outline-none data-[highlighted]:bg-error-bg"
            onSelect={onDelete}
          >
            <TrashIcon className="size-3.5" />
            Delete project
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
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

function FolderPlusIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.35"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2.25 5.25h11.5v7.5H2.25z" />
      <path d="M2.25 5.25V3.5h4l1.25 1.75" />
      <path d="M8 7.25v3.5M6.25 9h3.5" />
    </svg>
  );
}

function FolderIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.35"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2.25 5.25h11.5v7.5H2.25z" />
      <path d="M2.25 5.25V3.5h4l1.25 1.75" />
    </svg>
  );
}

function ChevronIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m3.5 4.5 2.5 2.5 2.5-2.5" />
    </svg>
  );
}

function MoreIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
    >
      <circle cx="3" cy="8" r="1.1" />
      <circle cx="8" cy="8" r="1.1" />
      <circle cx="13" cy="8" r="1.1" />
    </svg>
  );
}

function CheckIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m2.25 6.25 2.25 2.25 5.25-5.25" />
    </svg>
  );
}

function PencilIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m3 10.75.5-2.25 6-6 2 2-6 6z" />
      <path d="m8.5 3.5 2 2" />
    </svg>
  );
}

function TrashIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3.25 4.25h7.5M5.25 4.25V2.75h3.5v1.5M4.25 4.25l.5 7h4.5l.5-7" />
    </svg>
  );
}

function DeviceIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.35"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="2" y="2.25" width="10" height="7" rx="1" />
      <path d="M5 11.75h4M7 9.25v2.5" />
    </svg>
  );
}

function InboxSmallIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.35"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m2.5 9 1.75-5.5h7.5L13.5 9" />
      <path d="M2.5 9h3l.75 1.5h1.5L8.5 9h3" />
      <path d="M2.5 9v3h11V9" />
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
  projects,
  assignedProjectId,
  saving,
  onSelect,
  onAssign,
  onDragStart,
  onDragEnd,
}: {
  thread: ConversationThreadPublic;
  active: boolean;
  activeCount: number;
  needsApproval?: boolean;
  unread?: boolean;
  projects: HermesTaskProject[];
  assignedProjectId: string | null;
  saving: boolean;
  onSelect?: (threadId: string | null) => void;
  onAssign: (threadId: string, projectId: string | null) => Promise<void>;
  onDragStart: (threadId: string) => void;
  onDragEnd: () => void;
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
  const canOrganize = projects.length > 0;

  return (
    <div
      data-testid={`hermes-task-${thread.id}`}
      className={`group relative flex w-full items-center transition-colors duration-150 ${rowTone}`}
      draggable={canOrganize && !saving}
      onDragStart={(event) => {
        if (!canOrganize) return;
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("application/x-thechat-thread", thread.id);
        event.dataTransfer.setData("text/plain", thread.id);
        onDragStart(thread.id);
      }}
      onDragEnd={onDragEnd}
    >
      <button
        type="button"
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 px-2.5 py-2.5 text-left"
        onClick={() => onSelect?.(thread.id)}
        aria-current={active ? "true" : undefined}
      >
        <span
          className={`absolute top-2 bottom-2 left-0 w-0.5 rounded-r-sm ${
            active
              ? "bg-accent"
              : needsApproval
                ? "bg-warning-text"
                : "bg-transparent"
          }`}
          aria-hidden="true"
        />
        <span
          className={`flex size-7 shrink-0 items-center justify-center rounded border ${iconTone}`}
        >
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
      {canOrganize && (
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button
              type="button"
              className="mr-1 flex size-7 shrink-0 cursor-pointer items-center justify-center rounded text-text-dimmed opacity-0 transition hover:bg-raised hover:text-text group-hover:opacity-100 focus:opacity-100 data-[state=open]:bg-raised data-[state=open]:opacity-100"
              aria-label={`Organize ${thread.title}`}
              disabled={saving}
            >
              <MoreIcon className="size-4" />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              side="left"
              align="start"
              sideOffset={6}
              className="z-50 min-w-48 rounded-md border border-border bg-surface p-1 shadow-xl"
            >
              <DropdownMenu.Label className="px-2 py-1 text-[0.643rem] font-medium uppercase tracking-wide text-text-dimmed">
                Move to
              </DropdownMenu.Label>
              <DropdownMenu.Item
                className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[0.786rem] text-text-secondary outline-none data-[highlighted]:bg-hover data-[highlighted]:text-text"
                onSelect={() => void onAssign(thread.id, null)}
              >
                <span className="flex size-3.5 items-center justify-center text-accent">
                  {!assignedProjectId && <CheckIcon className="size-3.5" />}
                </span>
                <InboxSmallIcon className="size-3.5 text-text-dimmed" />
                <span className="truncate">Unfiled</span>
              </DropdownMenu.Item>
              <DropdownMenu.Separator className="my-1 h-px bg-border-subtle" />
              {projects.map((project) => (
                <DropdownMenu.Item
                  key={project.id}
                  className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[0.786rem] text-text-secondary outline-none data-[highlighted]:bg-hover data-[highlighted]:text-text"
                  onSelect={() => void onAssign(thread.id, project.id)}
                >
                  <span className="flex size-3.5 items-center justify-center text-accent">
                    {assignedProjectId === project.id && (
                      <CheckIcon className="size-3.5" />
                    )}
                  </span>
                  <span
                    className={`size-2 shrink-0 rounded-full ${PROJECT_COLOR_STYLES[project.color].dot}`}
                  />
                  <span className="truncate">{project.name}</span>
                </DropdownMenu.Item>
              ))}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      )}
    </div>
  );
}

function DraftThreadRow({ onSelect }: { onSelect?: () => void }) {
  return (
    <button
      type="button"
      className="group relative flex w-full cursor-pointer items-center gap-2.5 bg-accent/10 px-2.5 py-2.5 text-left text-text transition-colors duration-150"
      onClick={onSelect}
      data-testid="hermes-local-task-draft"
      aria-current="true"
    >
      <span
        className="absolute top-2 bottom-2 left-0 w-0.5 rounded-r-sm bg-accent"
        aria-hidden="true"
      />
      <span className="flex size-7 shrink-0 items-center justify-center rounded border border-accent/35 bg-accent/10 text-accent">
        <TaskIcon />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[0.857rem] font-medium">New task</span>
        <span className="mt-0.5 text-[0.714rem] text-text-dimmed">
          Draft, not saved
        </span>
      </span>
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
          active
            ? "bg-accent"
            : needsApproval
              ? "bg-warning-text"
              : "bg-transparent"
        }`}
        aria-hidden="true"
      />
      <span
        className={`flex size-8 shrink-0 items-center justify-center rounded border ${iconTone}`}
      >
        <InboxIcon />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[0.929rem] font-semibold">General</span>
        <span className="mt-0.5 text-[0.714rem] text-text-dimmed">Inbox</span>
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
    <span
      className={`shrink-0 rounded px-1.5 py-0.5 text-[0.643rem] font-medium uppercase ${tone}`}
    >
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
