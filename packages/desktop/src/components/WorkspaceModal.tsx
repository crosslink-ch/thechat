import { useState, useEffect, useRef, type FormEvent } from "react";
import { create } from "zustand";
import { useWorkspacesStore } from "../stores/workspaces";

// Colocated visibility store
const useWorkspaceModalState = create(() => ({ open: false }));
export const openWorkspaceModal = () =>
  useWorkspaceModalState.setState({ open: true });
const closeWorkspaceModal = () =>
  useWorkspaceModalState.setState({ open: false });

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
    <div className="auth-overlay" onClick={closeWorkspaceModal}>
      <div className="auth-card" onClick={(e) => e.stopPropagation()}>
        <h2 className="auth-title">Create workspace</h2>

        <form onSubmit={handleSubmit} noValidate>
          <div className="auth-field">
            <label className="auth-label" htmlFor="ws-name">
              Workspace name
            </label>
            <input
              ref={inputRef}
              id="ws-name"
              className="auth-input"
              type="text"
              placeholder="My Team"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          {error && <div className="auth-error">{error}</div>}

          <button className="auth-submit" type="submit" disabled={submitting}>
            {submitting ? "..." : "Create"}
          </button>
        </form>
      </div>
    </div>
  );
}
