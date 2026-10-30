import { onSessionReset } from "../lib/session-boundary";
import { create } from "zustand";
import type { MessageQuoteDraft } from "@thechat/shared";
import type { ImageAttachment } from "../lib/image-types";
import type { SharedAttachmentDraft } from "../lib/shared-attachments";

interface ComposerDraftsStore {
  drafts: Record<string, string>;
  revisions: Record<string, number>;
  imageDrafts: Record<string, ImageAttachment[]>;
  attachmentDrafts: Record<string, SharedAttachmentDraft[]>;
  sendingAttachments: Record<string, boolean>;
  /** The snippet the next message replies to, per composer. */
  quoteDrafts: Record<string, MessageQuoteDraft>;
  setDraft: (key: string, text: string) => void;
  restoreDraft: (key: string, expectedRevision: number, text: string) => boolean;
  setImageDrafts: (key: string, drafts: ImageAttachment[]) => void;
  setAttachmentDrafts: (key: string, drafts: SharedAttachmentDraft[]) => void;
  setSendingAttachments: (key: string, sending: boolean) => void;
  setQuoteDraft: (key: string, quote: MessageQuoteDraft | null) => void;
  /** Clear the quote only if it is still `expected`, so a newer pick survives. */
  clearQuoteDraft: (key: string, expected: MessageQuoteDraft) => void;
  /** Put a quote back after a rejected send unless another one was picked. */
  restoreQuoteDraft: (key: string, quote: MessageQuoteDraft) => void;
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

function updatedScopedList<T>(
  current: Record<string, T[]>,
  key: string,
  value: T[],
) {
  const next = { ...current };
  if (value.length === 0) delete next[key];
  else next[key] = value;
  return next;
}

/** In-memory only: unsent text, files, and attachment metadata never persist to disk. */
export const useComposerDraftsStore = create<ComposerDraftsStore>()((set) => ({
  drafts: {},
  revisions: {},
  imageDrafts: {},
  attachmentDrafts: {},
  sendingAttachments: {},
  quoteDrafts: {},

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

  setImageDrafts: (key, drafts) => {
    set((state) => {
      if (state.imageDrafts[key] === drafts) return state;
      return { imageDrafts: updatedScopedList(state.imageDrafts, key, drafts) };
    });
  },

  setAttachmentDrafts: (key, drafts) => {
    set((state) => {
      if (state.attachmentDrafts[key] === drafts) return state;
      return {
        attachmentDrafts: updatedScopedList(
          state.attachmentDrafts,
          key,
          drafts,
        ),
      };
    });
  },

  setSendingAttachments: (key, sending) => {
    set((state) => {
      if ((state.sendingAttachments[key] ?? false) === sending) return state;
      const sendingAttachments = { ...state.sendingAttachments };
      if (sending) sendingAttachments[key] = true;
      else delete sendingAttachments[key];
      return { sendingAttachments };
    });
  },

  setQuoteDraft: (key, quote) => {
    set((state) => {
      if ((state.quoteDrafts[key] ?? null) === quote) return state;
      const quoteDrafts = { ...state.quoteDrafts };
      if (quote) quoteDrafts[key] = quote;
      else delete quoteDrafts[key];
      return { quoteDrafts };
    });
  },

  clearQuoteDraft: (key, expected) => {
    set((state) => {
      if (state.quoteDrafts[key] !== expected) return state;
      const quoteDrafts = { ...state.quoteDrafts };
      delete quoteDrafts[key];
      return { quoteDrafts };
    });
  },

  restoreQuoteDraft: (key, quote) => {
    set((state) => {
      if (state.quoteDrafts[key] !== undefined) return state;
      return { quoteDrafts: { ...state.quoteDrafts, [key]: quote } };
    });
  },

  moveDraft: (fromKey, toKey) => {
    if (fromKey === toKey) return;
    set((state) => {
      const text = state.drafts[fromKey];
      const images = state.imageDrafts[fromKey];
      const attachments = state.attachmentDrafts[fromKey];
      const sending = state.sendingAttachments[fromKey];
      const quote = state.quoteDrafts[fromKey];
      if (
        text === undefined &&
        images === undefined &&
        attachments === undefined &&
        sending === undefined &&
        quote === undefined
      ) {
        return state;
      }

      const drafts = { ...state.drafts };
      const imageDrafts = { ...state.imageDrafts };
      const attachmentDrafts = { ...state.attachmentDrafts };
      const sendingAttachments = { ...state.sendingAttachments };
      const quoteDrafts = { ...state.quoteDrafts };
      delete drafts[fromKey];
      delete imageDrafts[fromKey];
      delete attachmentDrafts[fromKey];
      delete sendingAttachments[fromKey];
      delete quoteDrafts[fromKey];
      if (quoteDrafts[toKey] === undefined && quote !== undefined) {
        quoteDrafts[toKey] = quote;
      }
      if (drafts[toKey] === undefined && text !== undefined) drafts[toKey] = text;
      if (imageDrafts[toKey] === undefined && images !== undefined) {
        imageDrafts[toKey] = images;
      }
      if (attachmentDrafts[toKey] === undefined && attachments !== undefined) {
        attachmentDrafts[toKey] = attachments;
      }
      if (sendingAttachments[toKey] === undefined && sending !== undefined) {
        sendingAttachments[toKey] = sending;
      }

      return {
        drafts,
        imageDrafts,
        attachmentDrafts,
        sendingAttachments,
        quoteDrafts,
        revisions: {
          ...state.revisions,
          [fromKey]: (state.revisions[fromKey] ?? 0) + 1,
          [toKey]: (state.revisions[toKey] ?? 0) + 1,
        },
      };
    });
  },
}));

onSessionReset(() => {
  const state = useComposerDraftsStore.getState();
  for (const drafts of Object.values(state.attachmentDrafts)) {
    for (const draft of drafts) if (draft.previewUrl) URL.revokeObjectURL(draft.previewUrl);
  }
  // Advance old revisions so pending send rollback cannot resurrect a cleared draft.
  const revisions = Object.fromEntries(Object.entries(state.revisions).map(([key, value]) => [key, value + 1]));
  useComposerDraftsStore.setState({ ...useComposerDraftsStore.getInitialState(), revisions });
});
