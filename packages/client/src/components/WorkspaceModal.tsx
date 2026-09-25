import { useState, useRef, type FormEvent } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { create } from "zustand";
import { useWorkspacesStore } from "../stores/workspaces";
import { requestInputBarFocus } from "../stores/input-focus";
import { X } from "lucide-react";
import { buttonClass, dialogContentClass, dialogOverlayClass, dialogTitleClass, inputClass, labelClass } from "./ui";

// Colocated visibility store
const useWorkspaceModalState = create(() => ({ open: false }));
export const openWorkspaceModal = () =>
  useWorkspaceModalState.setState({ open: true });
const closeWorkspaceModal = () => {
  useWorkspaceModalState.setState({ open: false });
  requestInputBarFocus();
};

export function WorkspaceModal() {
  const open = useWorkspaceModalState((s) => s.open);
  if (!open) return null;
  return <WorkspaceModalInner />;
}

function WorkspaceModalInner() {
  const createWorkspace = useWorkspacesStore((s) => s.createWorkspace);

  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setSubmitting(true);

    try {
      if (!name.trim()) {
        setError("Workspace name is required");
        setSubmitting(false);
        return;
      }
      await createWorkspace(name.trim());
      closeWorkspaceModal();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) closeWorkspaceModal(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className={`z-50 ${dialogOverlayClass}`} />
        <Dialog.Content onOpenAutoFocus={(event) => { event.preventDefault(); inputRef.current?.focus(); }} aria-describedby={undefined} className={`app-dialog fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-[400px] -translate-x-1/2 -translate-y-1/2 p-6 ${dialogContentClass}`}>
          <div className="mb-5 flex items-center justify-between gap-2">
            <Dialog.Title className={dialogTitleClass}>Create workspace</Dialog.Title>
            <Dialog.Close className="mobile-touch-button" aria-label="Close workspace dialog"><X size={18} aria-hidden="true" /></Dialog.Close>
          </div>

          <form onSubmit={handleSubmit} noValidate>
            <div className="mb-3.5">
              <label className={labelClass} htmlFor="ws-name">
                Workspace name
              </label>
              <input
                ref={inputRef}
                id="ws-name"
                className={`block ${inputClass}`}
                type="text"
                placeholder="My Team"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>

            {error && <div className="mb-3 rounded-lg border border-error-msg-border bg-error-msg-bg px-3 py-2 text-[0.857rem] text-error-bright">{error}</div>}

            <button
              className={`mt-1 w-full ${buttonClass("primary", "lg")}`}
              type="submit"
              disabled={submitting}
            >
              {submitting ? "..." : "Create"}
            </button>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
