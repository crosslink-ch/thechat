import { create } from "zustand";
import { onSessionReset } from "../lib/session-boundary";

interface TaskProjectExpansionStore {
  /**
   * Projects the user has opened in a Hermes task list. Projects are collapsed
   * unless listed, and the set outlives the panel, so switching to another bot
   * and back keeps the same projects open.
   */
  expandedProjectIds: ReadonlySet<string>;
  setProjectExpanded: (projectId: string, expanded: boolean) => void;
}

export const useTaskProjectExpansionStore = create<TaskProjectExpansionStore>()((set) => ({
  expandedProjectIds: new Set(),
  setProjectExpanded: (projectId, expanded) =>
    set((state) => {
      if (state.expandedProjectIds.has(projectId) === expanded) return state;
      const expandedProjectIds = new Set(state.expandedProjectIds);
      if (expanded) expandedProjectIds.add(projectId);
      else expandedProjectIds.delete(projectId);
      return { expandedProjectIds };
    }),
}));

onSessionReset(() =>
  useTaskProjectExpansionStore.setState(useTaskProjectExpansionStore.getInitialState()),
);
