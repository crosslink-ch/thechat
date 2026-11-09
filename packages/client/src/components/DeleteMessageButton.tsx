import * as Dialog from "@radix-ui/react-dialog";
import type { ChatMessage } from "@thechat/shared";
import { Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import { api } from "../lib/api";
import { authHeaders, edenErrorMessage } from "../lib/eden";
import { wsEvents } from "../lib/ws-events";
import { sessionGeneration } from "../lib/session-boundary";
import { useAuthStore } from "../stores/auth";
import { buttonClass, dialogContentClass, dialogOverlayClass, dialogTitleClass } from "./ui";

export function DeleteMessageButton({ message }: { message: ChatMessage }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  async function confirmDelete() {
    if (busy) return;
    setBusy(true);
    setError(null);
    const generation = sessionGeneration();
    try {
      const { data, error: failure } = await api
        .messages({ conversationId: message.conversationId })({ messageId: message.id })
        .delete(undefined, authHeaders(useAuthStore.getState().token));
      if (failure || !data || !("ok" in data)) {
        throw new Error(edenErrorMessage(failure, "Could not delete message"));
      }
      if (generation !== sessionGeneration()) return;
      setOpen(false);
      // Also reconcile the author when their WebSocket is disconnected. The
      // server event may arrive first; handling the same deletion twice is safe.
      wsEvents.emit("ws:message_deleted", data);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not delete message");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={(value) => {
      if (!busy) { setOpen(value); setError(null); }
    }}>
      <Dialog.Trigger asChild>
        <button type="button" aria-label="Delete message" title="Delete message"
          className="inline-flex size-7 cursor-pointer items-center justify-center rounded-full border border-border bg-transparent text-text-dimmed transition-colors hover:border-error hover:bg-error/10 hover:text-error-bright focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
          <Trash2 size={16} aria-hidden="true" />
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className={`z-50 ${dialogOverlayClass}`} />
        <Dialog.Content
          className={`fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-[440px] -translate-x-1/2 -translate-y-1/2 p-5 ${dialogContentClass}`}
          onOpenAutoFocus={(event) => { event.preventDefault(); cancelRef.current?.focus(); }}
          onEscapeKeyDown={(event) => { if (busy) event.preventDefault(); }}
          onPointerDownOutside={(event) => { if (busy) event.preventDefault(); }}>
          <Dialog.Title className={dialogTitleClass}>Delete message?</Dialog.Title>
          <Dialog.Description className="mt-2 text-[0.857rem] leading-5 text-text-muted">
            This permanently deletes the message and its attachments for everyone. This cannot be undone.
          </Dialog.Description>
          <p className="mt-4 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-raised p-3 text-[0.857rem] text-text-muted">
            {message.content.slice(0, 500) || "Attachment message"}{message.content.length > 500 ? "…" : ""}
          </p>
          {error && <p role="alert" className="mt-3 text-[0.857rem] text-error-bright">{error}</p>}
          <div className="mt-5 flex justify-end gap-2">
            <Dialog.Close asChild><button ref={cancelRef} type="button" disabled={busy} className={buttonClass("secondary")}>Cancel</button></Dialog.Close>
            <button type="button" disabled={busy} className={buttonClass("danger")} onClick={() => void confirmDelete()}>
              {busy ? "Deleting…" : "Delete for everyone"}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
