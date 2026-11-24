import { create } from "zustand";
import type { WorkspaceWithDetails } from "@thechat/shared";
import { onSessionReset } from "../lib/session-boundary";
import { wsEvents } from "../lib/ws-events";
import { useAuthStore } from "./auth";
import { useWorkspacesStore } from "./workspaces";

type Pictures = Map<string, string | null>;
const usePictures = create<{ workspaces: Map<string, Pictures> }>(() => ({ workspaces: new Map() }));

// A conversation can stay on screen after the sidebar selects another workspace.
// Retain only profiles learned through authorized member responses, scoped to
// this login. This also lets a detached mention popup subscribe to live pictures.
function rememberWorkspace(workspace: WorkspaceWithDetails) {
  const pictures: Pictures = new Map(workspace.members
    .filter((member) => member.user.type === "human")
    .map((member) => [member.userId, member.user.avatar]));
  usePictures.setState((state) => {
    const workspaces = new Map(state.workspaces);
    // Pictures belong to people, not workspaces: refresh all known occurrences.
    for (const [id, previous] of workspaces) {
      workspaces.set(id, new Map([...previous].map(([userId, picture]) =>
        [userId, pictures.has(userId) ? pictures.get(userId)! : picture])));
    }
    workspaces.set(workspace.id, pictures);
    return { workspaces };
  });
}

const initial = useWorkspacesStore.getState().activeWorkspace;
if (initial) rememberWorkspace(initial);
useWorkspacesStore.subscribe((state, previous) => {
  if (state.loaded && state.workspaces !== previous.workspaces) {
    const permitted = new Set(state.workspaces.map((workspace) => workspace.id));
    usePictures.setState(({ workspaces }) => ({
      workspaces: new Map([...workspaces].filter(([id]) => permitted.has(id))),
    }));
  }
  if (state.activeWorkspace && state.activeWorkspace !== previous.activeWorkspace) {
    rememberWorkspace(state.activeWorkspace);
  }
});

wsEvents.on("ws:member_updated", ({ workspaceId, userId, avatar }) => {
  if (avatar === undefined) return;
  usePictures.setState((state) => {
    if (!state.workspaces.get(workspaceId)?.has(userId)) return state;
    return {
      workspaces: new Map([...state.workspaces].map(([id, pictures]) =>
        [id, pictures.has(userId) ? new Map(pictures).set(userId, avatar) : pictures])),
    };
  });
});
wsEvents.on("ws:member_removed", ({ workspaceId, userId }) => {
  usePictures.setState((state) => {
    const workspaces = new Map(state.workspaces);
    if (userId === useAuthStore.getState().user?.id) workspaces.delete(workspaceId);
    else if (workspaces.has(workspaceId)) {
      const pictures = new Map(workspaces.get(workspaceId));
      pictures.delete(userId);
      workspaces.set(workspaceId, pictures);
    }
    return { workspaces };
  });
});
onSessionReset(() => usePictures.setState({ workspaces: new Map() }));

export function useKnownProfilePicture(userId: string | null | undefined) {
  return usePictures((state) => {
    if (userId) for (const pictures of state.workspaces.values()) {
      if (pictures.has(userId)) return pictures.get(userId);
    }
    return undefined;
  });
}
