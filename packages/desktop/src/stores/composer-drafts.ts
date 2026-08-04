import { create } from "zustand";
import type { ImageAttachment } from "../lib/images";
import type { SharedAttachmentDraft } from "../lib/shared-attachments";

interface ComposerDraftsStore {
  drafts: Record<string, string>;
  revisions: Record<string, number>;
  imageDrafts: Record<string, ImageAttachment[]>;
  attachmentDrafts: Record<string, SharedAttachmentDraft[]>;
  sendingAttachments: Record<string, boolean>;
  setDraft: (key: string, text: string) => void;
  restoreDraft: (key: string, expectedRevision: number, text: string) => boolean;
  setImageDrafts: (key: string, drafts: ImageAttachment[]) => void;
  setAttachmentDrafts: (key: string, drafts: SharedAttachmentDraft[]) => void;
  setSendingAttachments: (key: string, sending: boolean) => void;
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

  moveDraft: (fromKey, toKey) => {
    if (fromKey === toKey) return;
    set((state) => {
      const text = state.drafts[fromKey];
      const images = state.imageDrafts[fromKey];
      const attachments = state.attachmentDrafts[fromKey];
      const sending = state.sendingAttachments[fromKey];
      if (
        text === undefined &&
        images === undefined &&
        attachments === undefined &&
        sending === undefined
      ) {
        return state;
      }

      const drafts = { ...state.drafts };
      const imageDrafts = { ...state.imageDrafts };
      const attachmentDrafts = { ...state.attachmentDrafts };
      const sendingAttachments = { ...state.sendingAttachments };
      delete drafts[fromKey];
      delete imageDrafts[fromKey];
      delete attachmentDrafts[fromKey];
      delete sendingAttachments[fromKey];
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
        revisions: {
          ...state.revisions,
          [fromKey]: (state.revisions[fromKey] ?? 0) + 1,
          [toKey]: (state.revisions[toKey] ?? 0) + 1,
        },
      };
    });
  },
}));
