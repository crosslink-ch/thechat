import { type FormEvent, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useMatches, useNavigate } from "@tanstack/react-router";
import * as Dialog from "@radix-ui/react-dialog";
import type { WorkspaceChannel } from "@thechat/shared";
import { useWorkspacesStore } from "../stores/workspaces";
import { useConversationsStore } from "../stores/conversations";

function HashIcon({ className = "" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
      <path d="M7 3 5.5 17M14.5 3 13 17M3 7h14M2.5 13h14" />
    </svg>
  );
}

function PencilIcon({ className = "" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="m13.8 3.2 3 3L7 16l-4 1 1-4Z" />
      <path d="m11.8 5.2 3 3" />
    </svg>
  );
}

function TrashIcon({ className = "" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3.5 5.5h13M8 3h4l1 2.5H7ZM6 8v7M10 8v7M14 8v7M5 5.5l.7 11.5h8.6L15 5.5" />
    </svg>
  );
}

function CloseIcon({ className = "" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
      <path d="m5 5 10 10M15 5 5 15" />
    </svg>
  );
}

type ChannelDialogState =
  | { mode: "create" }
  | { mode: "rename" | "delete"; channel: WorkspaceChannel };

let dialogState: ChannelDialogState | null = null;
let focusReturnTarget: HTMLElement | null = null;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((listener) => listener());
}

export function openCreateChannelModal() {
  rememberFocusReturnTarget();
  dialogState = { mode: "create" };
  emit();
}

export function openRenameChannelModal(channel: WorkspaceChannel) {
  rememberFocusReturnTarget();
  dialogState = { mode: "rename", channel };
  emit();
}

export function openDeleteChannelModal(channel: WorkspaceChannel) {
  rememberFocusReturnTarget();
  dialogState = { mode: "delete", channel };
  emit();
}

export function closeChannelModal() {
  dialogState = null;
  emit();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot() {
  return dialogState;
}

function rememberFocusReturnTarget() {
  focusReturnTarget =
    document.activeElement instanceof HTMLElement &&
    document.activeElement !== document.body
      ? document.activeElement
      : null;
}

function restoreFocusToLauncher() {
  const target = focusReturnTarget;
  focusReturnTarget = null;
  if (target?.isConnected) target.focus();
}

function channelSlug(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 100);
}

export function ChannelModal() {
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const navigate = useNavigate();
  const matches = useMatches();
  const activeChannelId = matches
    .map((match) => (match.params as Record<string, string>).id)
    .find(Boolean);
  const activeWorkspace = useWorkspacesStore((store) => store.activeWorkspace);
  const createChannel = useWorkspacesStore((store) => store.createChannel);
  const renameChannel = useWorkspacesStore((store) => store.renameChannel);
  const deleteChannel = useWorkspacesStore((store) => store.deleteChannel);
  const markChannelRead = useConversationsStore((store) => store.markChannelRead);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setName(state?.mode === "rename" ? (state.channel.title ?? state.channel.name) : "");
    setError("");
    setSubmitting(false);
  }, [state]);

  if (!state) return <Dialog.Root open={false} />;
  const currentState = state;

  const isDelete = currentState.mode === "delete";
  const slug = channelSlug(name);
  const title =
    currentState.mode === "create"
      ? "Create a channel"
      : currentState.mode === "rename"
        ? "Rename channel"
        : `Delete #${currentState.channel.name}?`;
  const description =
    currentState.mode === "create"
      ? `Add a place for your team to talk in ${activeWorkspace?.name ?? "this workspace"}.`
      : currentState.mode === "rename"
        ? "Choose a clear name that helps people find this conversation."
        : "This permanently deletes the channel and all of its message history.";

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (submitting) return;
    if (!isDelete && !slug) {
      setError("Enter a name with at least one letter or number.");
      return;
    }

    setSubmitting(true);
    setError("");
    try {
      if (currentState.mode === "create") {
        const channel = await createChannel(name);
        closeChannelModal();
        await navigate({
          to: "/channel/$id",
          params: { id: channel.id },
        });
        return;
      }

      if (currentState.mode === "rename") {
        await renameChannel(currentState.channel.id, name);
        closeChannelModal();
        return;
      }

      const deletedId = currentState.channel.id;
      await deleteChannel(deletedId);
      markChannelRead(deletedId);
      const nextChannel = useWorkspacesStore.getState().activeWorkspace?.channels[0];
      closeChannelModal();
      if (activeChannelId === deletedId) {
        if (nextChannel) {
          await navigate({
            to: "/channel/$id",
            params: { id: nextChannel.id },
          });
        } else {
          await navigate({ to: "/" });
        }
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Something went wrong");
    } finally {
      setSubmitting(false);
    }
  }

  const Icon =
    currentState.mode === "create"
      ? HashIcon
      : currentState.mode === "rename"
        ? PencilIcon
        : TrashIcon;

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !submitting) closeChannelModal();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/55 backdrop-blur-[1px]" />
        <Dialog.Content
          asChild
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            (isDelete ? cancelRef.current : inputRef.current)?.focus();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            restoreFocusToLauncher();
          }}
          onEscapeKeyDown={(event) => {
            if (submitting) event.preventDefault();
          }}
          onPointerDownOutside={(event) => {
            if (submitting) event.preventDefault();
          }}
        >
          <form
            onSubmit={handleSubmit}
            className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-[440px] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-xl border border-border bg-sidebar shadow-2xl"
          >
            <div className="flex items-start gap-3 px-5 pb-4 pt-5">
              <div
                className={`mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${
                  isDelete ? "bg-red-500/10 text-red-400" : "bg-accent/10 text-accent"
                }`}
              >
                <Icon className="size-5" />
              </div>
              <div className="min-w-0 flex-1">
                <Dialog.Title asChild>
                  <h2 className="text-[1.071rem] font-semibold text-text-primary">
                    {title}
                  </h2>
                </Dialog.Title>
                <Dialog.Description asChild>
                  <p className="mt-1 text-[0.857rem] leading-5 text-text-muted">
                    {description}
                  </p>
                </Dialog.Description>
              </div>
              <Dialog.Close asChild>
                <button
                  type="button"
                  disabled={submitting}
                  className="rounded-md p-1 text-text-placeholder transition-colors hover:bg-hover hover:text-text-secondary disabled:opacity-40"
                  aria-label="Close channel dialog"
                >
                  <CloseIcon className="size-[17px]" />
                </button>
              </Dialog.Close>
            </div>

            <div className="border-y border-border bg-base/35 px-5 py-4">
              {isDelete ? (
                <div className="rounded-lg border border-red-500/25 bg-red-500/[0.06] px-3.5 py-3 text-[0.821rem] leading-5 text-text-muted">
                  <p>
                    <span className="font-medium text-text-secondary">#{currentState.channel.name}</span> will disappear for every workspace member. This cannot be undone.
                  </p>
                  <p className="mt-1.5 text-text-placeholder">
                    Channels with attachments or active bot runs are protected from deletion.
                  </p>
                </div>
              ) : (
                <label className="block">
                  <span className="mb-1.5 block text-[0.786rem] font-medium text-text-secondary">
                    Channel name
                  </span>
                  <div className="flex items-center rounded-lg border border-border bg-base px-3 focus-within:border-accent/70 focus-within:ring-2 focus-within:ring-accent/15">
                    <HashIcon className="size-[15px] shrink-0 text-text-placeholder" />
                    <input
                      ref={inputRef}
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      maxLength={100}
                      aria-label="Channel name"
                      placeholder="e.g. product-updates"
                      className="min-w-0 flex-1 bg-transparent px-2 py-2.5 text-[0.929rem] text-text-primary outline-none placeholder:text-text-placeholder"
                    />
                  </div>
                  <p className="mt-2 text-[0.75rem] text-text-placeholder">
                    {slug ? (
                      <>
                        This channel will appear as <span className="font-medium text-text-muted">#{slug}</span>.
                      </>
                    ) : (
                      "Use letters, numbers, spaces, or hyphens."
                    )}
                  </p>
                </label>
              )}
              {error && (
                <p role="alert" className="mt-3 text-[0.786rem] text-red-400">
                  {error}
                </p>
              )}
            </div>

            <div className="flex justify-end gap-2 px-5 py-4">
              <Dialog.Close asChild>
                <button
                  ref={cancelRef}
                  type="button"
                  disabled={submitting}
                  className="rounded-md border border-border px-3.5 py-2 text-[0.857rem] font-medium text-text-secondary transition-colors hover:bg-hover disabled:opacity-40"
                >
                  Cancel
                </button>
              </Dialog.Close>
              <button
                type="submit"
                disabled={submitting || (!isDelete && !slug)}
                className={`rounded-md px-3.5 py-2 text-[0.857rem] font-medium text-white transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${
                  isDelete
                    ? "bg-red-600 hover:bg-red-500"
                    : "bg-accent hover:bg-accent-hover"
                }`}
              >
                {submitting
                  ? currentState.mode === "delete"
                    ? "Deleting..."
                    : "Saving..."
                  : currentState.mode === "create"
                    ? "Create channel"
                    : currentState.mode === "rename"
                      ? "Save changes"
                      : "Delete channel"}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
