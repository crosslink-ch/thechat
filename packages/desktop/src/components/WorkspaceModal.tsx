import { useState, useEffect, useRef, type FormEvent } from "react";
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

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeWorkspaceModal();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, []);

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
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-overlay backdrop-blur-[2px] animate-fade-in" onClick={closeWorkspaceModal}>
      <div className="w-full max-w-[400px] rounded-xl border border-border-strong bg-surface p-6 shadow-card animate-slide-up" onClick={(e) => e.stopPropagation()}>
        <h2 className="mb-5 text-[17px] font-semibold tracking-tight text-text">Create workspace</h2>

        <form onSubmit={handleSubmit} noValidate>
          <div className="mb-3.5">
            <label className="mb-1.5 block text-[12px] font-medium text-text-muted" htmlFor="ws-name">
              Workspace name
            </label>
            <input
              ref={inputRef}
              id="ws-name"
              className="block w-full rounded-lg border border-border bg-base px-3.5 py-2.5 font-[inherit] text-[13px] text-text outline-none transition-colors duration-150 placeholder:text-text-placeholder focus:border-border-focus"
              type="text"
              placeholder="My Team"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          {error && <div className="mb-3 rounded-lg border border-error-msg-border bg-error-msg-bg px-3 py-2 text-[12px] text-error-bright">{error}</div>}

          <button
            className="mt-1 block w-full cursor-pointer rounded-lg border border-border-strong bg-elevated px-3 py-2.5 font-[inherit] text-[13px] font-medium text-text transition-colors duration-150 hover:not-disabled:bg-button disabled:cursor-default disabled:opacity-40"
            type="submit"
            disabled={submitting}
          >
            {submitting ? "..." : "Create"}
          </button>
        </form>
      </div>
    </div>
  );
}
