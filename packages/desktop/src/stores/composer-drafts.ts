import { create } from "zustand";

interface ComposerDraftsStore {
  drafts: Record<string, string>;
  revisions: Record<string, number>;
  setDraft: (key: string, text: string) => void;
  restoreDraft: (key: string, expectedRevision: number, text: string) => boolean;
  moveDraft: (fromKey: string, toKey: string) => void;
}

const accountScope = (userId: string | undefined) =>
  `account:${userId ?? "anonymous"}`;

export const composerDraftKey = {
  agent: (routeConversationId: string | undefined) =>
    `agent:${routeConversationId ?? "new"}`,
  channel: (userId: string | undefined, conversationId: string) =>
    `${accountScope(userId)}:channel:${conversationId}`,
  dm: (
    userId: string | undefined,
    conversationId: string,
    threadId: string | null = null,
  ) =>
    `${accountScope(userId)}:dm:${conversationId}:${
      threadId ? `thread:${threadId}` : "general"
    }`,
};

function updatedDraftState(
  state: Pick<ComposerDraftsStore, "drafts" | "revisions">,
  key: string,
  text: string,
) {
  const drafts = { ...state.drafts };
  if (text.length === 0) delete drafts[key];
  else drafts[key] = text;
  return {
    drafts,
    revisions: {
      ...state.revisions,
      [key]: (state.revisions[key] ?? 0) + 1,
    },
  };
}

/** In-memory only: unsent message text is never persisted to disk. */
export const useComposerDraftsStore = create<ComposerDraftsStore>()((set) => ({
  drafts: {},
  revisions: {},

  setDraft: (key, text) => {
    set((state) => {
      if ((state.drafts[key] ?? "") === text) return state;
      return updatedDraftState(state, key, text);
    });
  },

  restoreDraft: (key, expectedRevision, text) => {
    let restored = false;
    set((state) => {
      if ((state.revisions[key] ?? 0) !== expectedRevision) return state;
      restored = true;
      if ((state.drafts[key] ?? "") === text) return state;
      return updatedDraftState(state, key, text);
    });
    return restored;
  },

  moveDraft: (fromKey, toKey) => {
    if (fromKey === toKey) return;
    set((state) => {
      const text = state.drafts[fromKey];
      if (text === undefined) return state;

      const drafts = { ...state.drafts };
      delete drafts[fromKey];
      if (drafts[toKey] === undefined) drafts[toKey] = text;

      return {
        drafts,
        revisions: {
          ...state.revisions,
          [fromKey]: (state.revisions[fromKey] ?? 0) + 1,
          [toKey]: (state.revisions[toKey] ?? 0) + 1,
        },
      };
    });
  },
}));
