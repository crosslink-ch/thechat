import { useState, useEffect, useRef, type FormEvent } from "react";

interface WorkspaceModalProps {
  onCreateWorkspace: (name: string) => Promise<void>;
  onJoinWorkspace: (id: string) => Promise<void>;
  onClose: () => void;
}

export function WorkspaceModal({
  onCreateWorkspace,
  onJoinWorkspace,
  onClose,
}: WorkspaceModalProps) {
  const [mode, setMode] = useState<"create" | "join">("create");
  const [name, setName] = useState("");
  const [workspaceId, setWorkspaceId] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, [mode]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setSubmitting(true);

    try {
      if (mode === "create") {
        if (!name.trim()) {
          setError("Workspace name is required");
          setSubmitting(false);
          return;
        }
        await onCreateWorkspace(name.trim());
      } else {
        if (!workspaceId.trim()) {
          setError("Workspace ID is required");
          setSubmitting(false);
          return;
        }
        await onJoinWorkspace(workspaceId.trim());
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="auth-overlay" onClick={onClose}>
      <div className="auth-card" onClick={(e) => e.stopPropagation()}>
        <h2 className="auth-title">
          {mode === "create" ? "Create workspace" : "Join workspace"}
        </h2>

        <form onSubmit={handleSubmit} noValidate>
          {mode === "create" ? (
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
          ) : (
            <div className="auth-field">
              <label className="auth-label" htmlFor="ws-id">
                Workspace ID
              </label>
              <input
                ref={inputRef}
                id="ws-id"
                className="auth-input"
                type="text"
                placeholder="my-team-12345"
                value={workspaceId}
                onChange={(e) => setWorkspaceId(e.target.value)}
              />
            </div>
          )}

          {error && <div className="auth-error">{error}</div>}

          <button className="auth-submit" type="submit" disabled={submitting}>
            {submitting
              ? "..."
              : mode === "create"
                ? "Create"
                : "Join"}
          </button>
        </form>

        <div className="auth-switch">
          {mode === "create" ? (
            <>
              Have an invite?{" "}
              <button onClick={() => { setMode("join"); setError(""); }}>
                Join workspace
              </button>
            </>
          ) : (
            <>
              Start fresh?{" "}
              <button onClick={() => { setMode("create"); setError(""); }}>
                Create workspace
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
