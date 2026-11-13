import { onSessionReset } from "../lib/session-boundary";
import { create } from "zustand";
import type { ImageAttachment } from "../lib/image-types";
import type { SharedAttachmentDraft } from "../lib/shared-attachments";
import {
  composerFromText,
  sameComposerDocument,
  type ComposerDocument,
  type MessageInput,
} from "../lib/composer-parts";

/**
 * A draft is a composer document: its readable text plus the ordered parts,
 * so mentions picked from the @ menu keep their user IDs when a draft is
 * restored, moved or put back after a failed send.
 */
export type ComposerDraft = ComposerDocument;

interface ComposerDraftsStore {
  drafts: Record<string, ComposerDraft>;
  revisions: Record<string, number>;
  imageDrafts: Record<string, ImageAttachment[]>;
  attachmentDrafts: Record<string, SharedAttachmentDraft[]>;
  sendingAttachments: Record<string, boolean>;
  /** Text (no mentions) or a composer document. */
  setDraft: (key: string, value: MessageInput) => void;
  restoreDraft: (key: string, expectedRevision: number, value: MessageInput) => boolean;
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
  /** The composer of one reply thread (Slack-style), kept per root message. */
  replyThread: (userId: string | undefined, conversationId: string, rootMessageId: string) =>
    `${accountScope(userId)}:reply:${conversationId}:${rootMessageId}`,
};

function asDraft(value: MessageInput): ComposerDraft {
  return typeof value === "string" ? composerFromText(value) : value;
}

/** The text of a stored draft ("" when there is none). */
export function draftText(draft: ComposerDraft | undefined) {
  return draft?.text ?? "";
}

/** Same text (whitespace included) and the same mention IDs. */
export function sameDraft(left: ComposerDraft | undefined, right: ComposerDraft | undefined) {
  return sameComposerDocument(left ?? composerFromText(""), right ?? composerFromText(""));
}

function updatedDraftState(
  state: Pick<ComposerDraftsStore, "drafts" | "revisions">,
  key: string,
  draft: ComposerDraft,
) {
  const drafts = { ...state.drafts };
  if (draft.parts.length === 0) delete drafts[key];
  else drafts[key] = draft;
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

  setDraft: (key, value) => {
    const draft = asDraft(value);
    set((state) => {
      if (sameDraft(state.drafts[key], draft)) return state;
      return updatedDraftState(state, key, draft);
    });
  },

  restoreDraft: (key, expectedRevision, value) => {
    const draft = asDraft(value);
    let restored = false;
    set((state) => {
      if ((state.revisions[key] ?? 0) !== expectedRevision) return state;
      restored = true;
      if (sameDraft(state.drafts[key], draft)) return state;
      return updatedDraftState(state, key, draft);
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

onSessionReset(() => {
  const state = useComposerDraftsStore.getState();
  for (const drafts of Object.values(state.attachmentDrafts)) {
    for (const draft of drafts) if (draft.previewUrl) URL.revokeObjectURL(draft.previewUrl);
  }
  // Advance old revisions so pending send rollback cannot resurrect a cleared draft.
  const revisions = Object.fromEntries(Object.entries(state.revisions).map(([key, value]) => [key, value + 1]));
  useComposerDraftsStore.setState({ ...useComposerDraftsStore.getInitialState(), revisions });
});
