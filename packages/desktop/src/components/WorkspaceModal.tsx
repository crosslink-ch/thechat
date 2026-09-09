import { useState, useRef, type FormEvent } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { create } from "zustand";
import { useWorkspacesStore } from "../stores/workspaces";
import { requestInputBarFocus } from "../stores/input-focus";

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
        <Dialog.Overlay className="fixed inset-0 z-50 bg-overlay backdrop-blur-[2px]" />
        <Dialog.Content onOpenAutoFocus={(event) => { event.preventDefault(); inputRef.current?.focus(); }} aria-describedby={undefined} className="app-dialog fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-[400px] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border-strong bg-surface p-6 shadow-card">
          <div className="mb-5 flex items-center justify-between gap-2">
            <Dialog.Title className="text-[1.214rem] font-semibold tracking-tight text-text">Create workspace</Dialog.Title>
            <Dialog.Close className="mobile-touch-button" aria-label="Close workspace dialog">✕</Dialog.Close>
          </div>

          <form onSubmit={handleSubmit} noValidate>
            <div className="mb-3.5">
              <label className="mb-1.5 block text-[0.857rem] font-medium text-text-muted" htmlFor="ws-name">
                Workspace name
              </label>
              <input
                ref={inputRef}
                id="ws-name"
                className="block w-full rounded-lg border border-border bg-base px-3.5 py-2.5 font-[inherit] text-[0.929rem] text-text outline-none transition-colors duration-150 placeholder:text-text-placeholder focus:border-border-focus"
                type="text"
                placeholder="My Team"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>

            {error && <div className="mb-3 rounded-lg border border-error-msg-border bg-error-msg-bg px-3 py-2 text-[0.857rem] text-error-bright">{error}</div>}

            <button
              className="mt-1 block w-full cursor-pointer rounded-lg border border-border-strong bg-elevated px-3 py-2.5 font-[inherit] text-[0.929rem] font-medium text-text transition-colors duration-150 hover:not-disabled:bg-button disabled:cursor-default disabled:opacity-40"
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
