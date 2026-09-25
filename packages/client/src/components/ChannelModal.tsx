import { type FormEvent, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useMatches, useNavigate } from "@tanstack/react-router";
import * as Dialog from "@radix-ui/react-dialog";
import type { WorkspaceChannel } from "@thechat/shared";
import { useWorkspacesStore } from "../stores/workspaces";
import { useConversationsStore } from "../stores/conversations";
import { useAuthStore } from "../stores/auth";
import { Hash, Pencil, Trash2, X } from "lucide-react";
import { buttonClass, dialogContentClass, dialogOverlayClass, dialogTitleClass, iconButtonClass } from "./ui";

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
  const currentUserId = useAuthStore((store) => store.user?.id);
  const createChannel = useWorkspacesStore((store) => store.createChannel);
  const renameChannel = useWorkspacesStore((store) => store.renameChannel);
  const deleteChannel = useWorkspacesStore((store) => store.deleteChannel);
  const markChannelRead = useConversationsStore((store) => store.markChannelRead);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const currentMembership = activeWorkspace?.members.find(
    (member) => member.userId === currentUserId,
  );
  const canUseChannelModal = Boolean(
    currentMembership &&
    (state?.mode === "create" ||
      currentMembership.role === "owner" ||
      currentMembership.role === "admin"),
  );

  useEffect(() => {
    setName(state?.mode === "rename" ? (state.channel.title ?? state.channel.name) : "");
    setError("");
    setSubmitting(false);
  }, [state]);

  useEffect(() => {
    if (state && currentUserId && !canUseChannelModal) {
      closeChannelModal();
    }
  }, [canUseChannelModal, currentUserId, state]);

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
    const latestWorkspace = useWorkspacesStore.getState().activeWorkspace;
    const latestUserId = useAuthStore.getState().user?.id;
    const latestMembership = latestWorkspace?.members.find(
      (member) => member.userId === latestUserId,
    );
    const stillAuthorized = Boolean(
      latestMembership &&
      (currentState.mode === "create" ||
        latestMembership.role === "owner" ||
        latestMembership.role === "admin"),
    );
    if (!stillAuthorized) {
      closeChannelModal();
      return;
    }
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
      ? Hash
      : currentState.mode === "rename"
        ? Pencil
        : Trash2;

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !submitting) closeChannelModal();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={`z-50 ${dialogOverlayClass}`} />
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
            className={`fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-[440px] -translate-x-1/2 -translate-y-1/2 overflow-hidden ${dialogContentClass}`}
          >
            <div className="flex items-start gap-3 px-5 pb-4 pt-5">
              <div
                className={`mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${
                  isDelete ? "bg-error/10 text-error-bright" : "bg-accent/10 text-accent"
                }`}
              >
                <Icon size={18} aria-hidden="true" />
              </div>
              <div className="min-w-0 flex-1">
                <Dialog.Title asChild>
                  <h2 className={dialogTitleClass}>
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
                  className={`-mr-1.5 -mt-1 ${iconButtonClass("md")}`}
                  aria-label="Close channel dialog"
                >
                  <X size={16} aria-hidden="true" />
                </button>
              </Dialog.Close>
            </div>

            <div className="px-5 pb-2 pt-1">
              {isDelete ? (
                <div className="rounded-lg border border-error-border bg-error-msg-bg px-3.5 py-3 text-[0.821rem] leading-5 text-text-muted">
                  <p>
                    <span className="font-medium text-text-secondary">#{currentState.channel.name}</span> will disappear for every workspace member. This cannot be undone.
                  </p>
                  <p className="mt-1.5 text-text-placeholder">
                    Channels with attachments or active bot runs are protected from deletion.
                  </p>
                </div>
              ) : (
                <label className="block">
                  <span className="mb-1.5 block text-[0.857rem] font-medium text-text-secondary">
                    Channel name
                  </span>
                  <div className="flex items-center rounded-lg border border-border-strong bg-base px-3 transition-[border-color,box-shadow] duration-150 focus-within:border-accent/60 focus-within:ring-3 focus-within:ring-accent/15">
                    <Hash size={15} className="shrink-0 text-text-placeholder" aria-hidden="true" />
                    <input
                      ref={inputRef}
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      maxLength={100}
                      aria-label="Channel name"
                      placeholder="e.g. product-updates"
                      className="min-w-0 flex-1 bg-transparent px-2 py-2 text-[0.929rem] text-text outline-none placeholder:text-text-placeholder"
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
                <p role="alert" className="mt-3 text-[0.786rem] text-error-bright">
                  {error}
                </p>
              )}
            </div>

            <div className="flex justify-end gap-2 px-5 pb-5 pt-3">
              <Dialog.Close asChild>
                <button
                  ref={cancelRef}
                  type="button"
                  disabled={submitting}
                  className={buttonClass("ghost", "md")}
                >
                  Cancel
                </button>
              </Dialog.Close>
              <button
                type="submit"
                disabled={submitting || (!isDelete && !slug)}
                className={buttonClass(isDelete ? "danger" : "primary", "md")}
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
