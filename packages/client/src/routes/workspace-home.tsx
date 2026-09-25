import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { openWorkspaceModal } from "../components/WorkspaceModal";
import { useWorkspacesStore } from "../stores/workspaces";
import { Plus } from "lucide-react";
import { buttonClass } from "../components/ui";

export function WorkspaceHomeRoute() {
  const navigate = useNavigate();
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const activeWorkspace = useWorkspacesStore((s) => s.activeWorkspace);
  const loading = useWorkspacesStore((s) => s.loading);
  const selectWorkspace = useWorkspacesStore((s) => s.selectWorkspace);
  const [selectingId, setSelectingId] = useState<string | null>(null);

  useEffect(() => {
    if (loading || activeWorkspace || workspaces.length !== 1) return;
    const workspace = workspaces[0];
    setSelectingId(workspace.id);
    void selectWorkspace(workspace.id).finally(() => setSelectingId(null));
  }, [activeWorkspace, loading, selectWorkspace, workspaces]);

  useEffect(() => {
    const firstChannel = activeWorkspace?.channels[0];
    if (!firstChannel) return;
    navigate({
      to: "/channel/$id",
      params: { id: firstChannel.id },
      replace: true,
    });
  }, [activeWorkspace, navigate]);

  if (loading || selectingId) {
    return (
      <div className="flex h-full items-center justify-center text-[0.929rem] text-text-dimmed">
        Loading workspace...
      </div>
    );
  }

  if (activeWorkspace) {
    return (
      <div className="mx-auto flex h-full max-w-[620px] flex-col justify-center px-6 py-8">
        <div className="text-[1.429rem] font-semibold tracking-tight text-text">
          {activeWorkspace.name}
        </div>
        <p className="mt-1 text-[0.929rem] leading-relaxed text-text-muted">
          This workspace has no channels yet.
        </p>
        <div className="mt-5 flex gap-2">
          <button
            type="button"
            className={buttonClass("secondary", "md")}
            onClick={() => navigate({ to: "/workspace/manage" })}
          >
            Manage workspace
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto flex h-full max-w-[620px] flex-col justify-center px-6 py-8">
      <div className="text-[1.429rem] font-semibold tracking-tight text-text">
        Workspace
      </div>
      <p className="mt-1 text-[0.929rem] leading-relaxed text-text-muted">
        {workspaces.length > 0
          ? "Choose a workspace to continue."
          : "Create a workspace to start using channels and direct messages."}
      </p>

      {workspaces.length > 0 ? (
        <div className="-mx-3 mt-5 flex flex-col gap-0.5">
          {workspaces.map((workspace) => (
            <button
              key={workspace.id}
              type="button"
              className="flex w-full cursor-pointer items-center gap-3 rounded-lg border-none bg-transparent px-3 py-2 text-left font-[inherit] text-[0.929rem] text-text-secondary transition-colors duration-150 hover:bg-hover hover:text-text"
              onClick={() => {
                setSelectingId(workspace.id);
                void selectWorkspace(workspace.id).finally(() => setSelectingId(null));
              }}
            >
              <span
                aria-hidden="true"
                className="flex size-7 shrink-0 items-center justify-center rounded-md bg-white/[0.06] text-[0.857rem] font-semibold text-text-secondary"
              >
                {workspace.name.charAt(0).toUpperCase()}
              </span>
              <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap font-medium">
                {workspace.name}
              </span>
              <span className="text-[0.786rem] capitalize text-text-dimmed">{workspace.role}</span>
            </button>
          ))}
        </div>
      ) : (
        <button
          type="button"
          className={`mt-5 w-fit ${buttonClass("primary", "md")}`}
          onClick={openWorkspaceModal}
        >
          <Plus size={16} aria-hidden="true" />
          Create workspace
        </button>
      )}
    </div>
  );
}
