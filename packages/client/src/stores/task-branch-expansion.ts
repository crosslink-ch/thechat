import { create } from "zustand";
import { onSessionReset } from "../lib/session-boundary";

interface TaskBranchExpansionStore {
  /**
   * Tasks whose branches the user has folded away in a Hermes task list.
   * Branches are shown unless their source is listed. Task ids are UUIDs, so
   * one set covers every DM, and it outlives the panel like project expansion.
   */
  collapsedThreadIds: ReadonlySet<string>;
  setBranchesCollapsed: (threadId: string, collapsed: boolean) => void;
  /** Unfolds several tasks at once, e.g. every source of the open branch. */
  expandBranches: (threadIds: Iterable<string>) => void;
}

export const useTaskBranchExpansionStore = create<TaskBranchExpansionStore>()((set) => ({
  collapsedThreadIds: new Set(),
  setBranchesCollapsed: (threadId, collapsed) =>
    set((state) => {
      if (state.collapsedThreadIds.has(threadId) === collapsed) return state;
      const collapsedThreadIds = new Set(state.collapsedThreadIds);
      if (collapsed) collapsedThreadIds.add(threadId);
      else collapsedThreadIds.delete(threadId);
      return { collapsedThreadIds };
    }),
  expandBranches: (threadIds) =>
    set((state) => {
      const ids = [...threadIds].filter((id) => state.collapsedThreadIds.has(id));
      if (ids.length === 0) return state;
      const collapsedThreadIds = new Set(state.collapsedThreadIds);
      for (const id of ids) collapsedThreadIds.delete(id);
      return { collapsedThreadIds };
    }),
}));

onSessionReset(() =>
  useTaskBranchExpansionStore.setState(useTaskBranchExpansionStore.getInitialState()),
);
