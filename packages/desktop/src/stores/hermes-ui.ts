import { create } from "zustand";

interface HermesUiStore {
  activeSessionIds: Record<string, string | null>;
  setActiveSessionId: (conversationId: string, sessionId: string | null) => void;
  clear: () => void;
}

export const useHermesUiStore = create<HermesUiStore>()((set) => ({
  activeSessionIds: {},

  setActiveSessionId: (conversationId, sessionId) => {
    set((state) => ({
      activeSessionIds: {
        ...state.activeSessionIds,
        [conversationId]: sessionId,
      },
    }));
  },

  clear: () => set({ activeSessionIds: {} }),
}));
