import { useRef, useState, type FormEvent, type ReactNode, type RefObject } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  Check,
  Folder,
  FolderInput,
  FolderPlus,
  Inbox,
  Pencil,
  Trash2,
  X,
  type LucideIcon,
} from "lucide-react";
import type { ConversationThreadPublic, TaskProjectPublic } from "@thechat/shared";
import {
  buttonClass,
  dialogContentClass,
  dialogOverlayClass,
  dialogTitleClass,
  iconButtonClass,
  inputClass,
  menuItemBaseClass,
} from "./ui";

export const MAX_PROJECT_NAME_LENGTH = 100;

export type TaskPanelDialog =
  | { kind: "create-project"; moveThreadId?: string }
  | { kind: "rename-project"; project: TaskProjectPublic }
  | { kind: "delete-project"; project: TaskProjectPublic }
  | { kind: "move-task"; thread: ConversationThreadPublic }
  | { kind: "delete-task"; thread: ConversationThreadPublic };

export function TaskPanelDialogs({
  dialog,
  projects,
  onClose,
  onOpen,
  onCreateProject,
  onRenameProject,
  onDeleteProject,
  onMoveThread,
  onDeleteThread,
}: {
  dialog: TaskPanelDialog | null;
  projects: TaskProjectPublic[];
  onClose: () => void;
  onOpen: (dialog: TaskPanelDialog) => void;
  onCreateProject?: (name: string) => Promise<TaskProjectPublic | null>;
  onRenameProject?: (projectId: string, name: string) => Promise<unknown>;
  onDeleteProject?: (projectId: string) => Promise<unknown>;
  onMoveThread?: (threadId: string, projectId: string | null) => Promise<unknown>;
  onDeleteThread?: (threadId: string) => Promise<unknown>;
}) {
  if (!dialog) return null;
  switch (dialog.kind) {
    case "create-project":
      if (!onCreateProject) return null;
      return (
        <ProjectNameDialog
          key="create-project"
          mode="create"
          initialName=""
          onClose={onClose}
          onSubmit={async (name) => {
            const project = await onCreateProject(name);
            if (project && dialog.moveThreadId && onMoveThread) {
              await onMoveThread(dialog.moveThreadId, project.id);
            }
          }}
        />
      );
    case "rename-project":
      if (!onRenameProject) return null;
      return (
        <ProjectNameDialog
          key={`rename-${dialog.project.id}`}
          mode="rename"
          initialName={dialog.project.name}
          onClose={onClose}
          onSubmit={(name) => onRenameProject(dialog.project.id, name)}
        />
      );
    case "delete-project":
      if (!onDeleteProject) return null;
      return (
        <ConfirmDialog
          key={`delete-project-${dialog.project.id}`}
          title={`Delete project “${dialog.project.name}”?`}
          description="Its tasks move to No project. No tasks are deleted."
          confirmLabel="Delete project"
          busyLabel="Deleting..."
          onClose={onClose}
          onConfirm={() => onDeleteProject(dialog.project.id)}
        />
      );
    case "move-task":
      if (!onMoveThread) return null;
      return (
        <MoveTaskDialog
          key={`move-${dialog.thread.id}`}
          thread={dialog.thread}
          projects={projects}
          onClose={onClose}
          onMove={onMoveThread}
          onNewProject={
            onCreateProject
              ? () => onOpen({ kind: "create-project", moveThreadId: dialog.thread.id })
              : undefined
          }
        />
      );
    case "delete-task":
      if (!onDeleteThread) return null;
      return (
        <ConfirmDialog
          key={`delete-task-${dialog.thread.id}`}
          title={`Delete task “${dialog.thread.title}”?`}
          description="This permanently deletes the task with its messages, requests and files. This cannot be undone."
          confirmLabel="Delete task"
          busyLabel="Deleting..."
          onClose={onClose}
          onConfirm={() => onDeleteThread(dialog.thread.id)}
        />
      );
  }
}

function DialogShell({
  title,
  description,
  icon: Icon,
  danger = false,
  busy,
  initialFocusRef,
  onClose,
  onSubmit,
  children,
  actions,
}: {
  title: string;
  description: string;
  icon: LucideIcon;
  danger?: boolean;
  busy: boolean;
  initialFocusRef?: RefObject<HTMLInputElement | HTMLButtonElement | null>;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  children?: ReactNode;
  actions: ReactNode;
}) {
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={`z-50 ${dialogOverlayClass}`} />
        <Dialog.Content
          asChild
          onOpenAutoFocus={(event) => {
            const target = initialFocusRef?.current;
            if (!target) return;
            event.preventDefault();
            target.focus();
            if (target instanceof HTMLInputElement) target.select();
          }}
          onEscapeKeyDown={(event) => {
            if (busy) event.preventDefault();
          }}
          onPointerDownOutside={(event) => {
            if (busy) event.preventDefault();
          }}
        >
          <form
            onSubmit={onSubmit}
            className={`fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-[440px] -translate-x-1/2 -translate-y-1/2 overflow-hidden ${dialogContentClass}`}
          >
            <div className="flex items-start gap-3 px-5 pb-4 pt-5">
              <div
                className={`mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${
                  danger ? "bg-error/10 text-error-bright" : "bg-accent/10 text-accent"
                }`}
              >
                <Icon size={18} aria-hidden="true" />
              </div>
              <div className="min-w-0 flex-1">
                <Dialog.Title asChild>
                  <h2 className={`break-words ${dialogTitleClass}`}>{title}</h2>
                </Dialog.Title>
                <Dialog.Description asChild>
                  <p className="mt-1 text-[0.857rem] leading-5 text-text-muted">{description}</p>
                </Dialog.Description>
              </div>
              <Dialog.Close asChild>
                <button
                  type="button"
                  disabled={busy}
                  className={`-mr-1.5 -mt-1 ${iconButtonClass("md")}`}
                  aria-label="Close dialog"
                >
                  <X size={16} aria-hidden="true" />
                </button>
              </Dialog.Close>
            </div>
            {children && <div className="px-5 pb-2 pt-1">{children}</div>}
            <div className="flex justify-end gap-2 px-5 pb-5 pt-3">{actions}</div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function ErrorText({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <p role="alert" className="mt-3 text-[0.786rem] text-error-bright">
      {error}
    </p>
  );
}

function errorMessage(error: unknown) {
  return error instanceof Error && error.message ? error.message : "Something went wrong";
}

function ProjectNameDialog({
  mode,
  initialName,
  onSubmit,
  onClose,
}: {
  mode: "create" | "rename";
  initialName: string;
  onSubmit: (name: string) => Promise<unknown>;
  onClose: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const normalized = name.trim().replace(/\s+/g, " ");
    if (!normalized) {
      setError("Enter a project name.");
      return;
    }
    if (mode === "rename" && normalized === initialName) {
      onClose();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit(normalized);
      onClose();
    } catch (caught) {
      setError(errorMessage(caught));
      setBusy(false);
    }
  };

  return (
    <DialogShell
      title={mode === "create" ? "New project" : "Rename project"}
      description={
        mode === "create"
          ? "Group related tasks. Hermes sees the other tasks in a project when it works on one."
          : "Choose a clear name for this group of tasks."
      }
      icon={mode === "create" ? FolderPlus : Pencil}
      busy={busy}
      initialFocusRef={inputRef}
      onClose={onClose}
      onSubmit={submit}
      actions={
        <>
          <Dialog.Close asChild>
            <button type="button" disabled={busy} className={buttonClass("ghost", "md")}>
              Cancel
            </button>
          </Dialog.Close>
          <button
            type="submit"
            disabled={busy || !name.trim()}
            className={buttonClass("primary", "md")}
          >
            {busy ? "Saving..." : mode === "create" ? "Create project" : "Save changes"}
          </button>
        </>
      }
    >
      <label className="block">
        <span className="mb-1.5 block text-[0.857rem] font-medium text-text-secondary">
          Project name
        </span>
        <input
          ref={inputRef}
          value={name}
          maxLength={MAX_PROJECT_NAME_LENGTH}
          onChange={(event) => {
            setName(event.target.value);
            setError(null);
          }}
          aria-label="Project name"
          placeholder="e.g. Launch plan"
          disabled={busy}
          className={inputClass}
        />
      </label>
      <ErrorText error={error} />
    </DialogShell>
  );
}

function ConfirmDialog({
  title,
  description,
  confirmLabel,
  busyLabel,
  onConfirm,
  onClose,
}: {
  title: string;
  description: string;
  confirmLabel: string;
  busyLabel: string;
  onConfirm: () => Promise<unknown>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      onClose();
    } catch (caught) {
      setError(errorMessage(caught));
      setBusy(false);
    }
  };

  return (
    <DialogShell
      title={title}
      description={description}
      icon={Trash2}
      danger
      busy={busy}
      initialFocusRef={cancelRef}
      onClose={onClose}
      onSubmit={submit}
      actions={
        <>
          <Dialog.Close asChild>
            <button
              ref={cancelRef}
              type="button"
              disabled={busy}
              className={buttonClass("ghost", "md")}
            >
              Cancel
            </button>
          </Dialog.Close>
          <button type="submit" disabled={busy} className={buttonClass("danger", "md")}>
            {busy ? busyLabel : confirmLabel}
          </button>
        </>
      }
    >
      {error ? <ErrorText error={error} /> : null}
    </DialogShell>
  );
}

function MoveTaskDialog({
  thread,
  projects,
  onMove,
  onNewProject,
  onClose,
}: {
  thread: ConversationThreadPublic;
  projects: TaskProjectPublic[];
  onMove: (threadId: string, projectId: string | null) => Promise<unknown>;
  onNewProject?: () => void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const currentProjectId = thread.projectId ?? null;
  const currentRef = useRef<HTMLButtonElement>(null);
  const options: Array<{ id: string | null; name: string }> = [
    { id: null, name: "No project" },
    ...projects.map((project) => ({ id: project.id, name: project.name })),
  ];

  const move = async (projectId: string | null) => {
    if (busy) return;
    if (projectId === currentProjectId) {
      onClose();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onMove(thread.id, projectId);
      onClose();
    } catch (caught) {
      setError(errorMessage(caught));
      setBusy(false);
    }
  };

  return (
    <DialogShell
      title={`Move “${thread.title}”`}
      description="Choose the project this task belongs to."
      icon={FolderInput}
      busy={busy}
      initialFocusRef={currentRef}
      onClose={onClose}
      onSubmit={(event) => event.preventDefault()}
      actions={
        <Dialog.Close asChild>
          <button type="button" disabled={busy} className={buttonClass("ghost", "md")}>
            Cancel
          </button>
        </Dialog.Close>
      }
    >
      <div className="flex max-h-[280px] flex-col gap-0.5 overflow-y-auto" role="list">
        {options.map((option) => {
          const current = option.id === currentProjectId;
          const Icon = option.id ? Folder : Inbox;
          return (
            <div role="listitem" key={option.id ?? "none"}>
              <button
                ref={current ? currentRef : undefined}
                type="button"
                disabled={busy}
                aria-current={current ? "true" : undefined}
                onClick={() => void move(option.id)}
                className={`${menuItemBaseClass} ${
                  current ? "bg-accent/10 text-text" : "text-text-secondary hover:bg-hover hover:text-text"
                } focus-visible:ring-2 focus-visible:ring-accent/40`}
              >
                <Icon size={14} className="shrink-0 text-text-dimmed" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate">{option.name}</span>
                {current && <Check size={14} className="shrink-0 text-accent" aria-label="Current" />}
              </button>
            </div>
          );
        })}
        {onNewProject && (
          <div role="listitem">
            <button
              type="button"
              disabled={busy}
              onClick={onNewProject}
              className={`${menuItemBaseClass} text-accent hover:bg-hover focus-visible:ring-2 focus-visible:ring-accent/40`}
            >
              <FolderPlus size={14} className="shrink-0" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate">New project...</span>
            </button>
          </div>
        )}
      </div>
      <ErrorText error={error} />
    </DialogShell>
  );
}
