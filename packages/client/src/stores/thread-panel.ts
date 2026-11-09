import { create } from "zustand";
import { preferences } from "../platform/preferences";
import { onSessionReset } from "../lib/session-boundary";

/** Width limits of the reply-thread side panel, in CSS pixels. */
export const THREAD_PANEL_MIN_WIDTH = 320;
export const THREAD_PANEL_MAX_WIDTH = 720;
export const THREAD_PANEL_DEFAULT_WIDTH = 420;
/** The conversation always keeps at least this much room next to the panel. */
export const THREAD_PANEL_MIN_CONVERSATION_WIDTH = 360;

const WIDTH_KEY = "thread_panel_width";

export function clampThreadPanelWidth(width: number, containerWidth?: number) {
  const containerMax = containerWidth
    ? containerWidth - THREAD_PANEL_MIN_CONVERSATION_WIDTH
    : THREAD_PANEL_MAX_WIDTH;
  const max = Math.max(THREAD_PANEL_MIN_WIDTH, Math.min(THREAD_PANEL_MAX_WIDTH, containerMax));
  if (!Number.isFinite(width)) return THREAD_PANEL_DEFAULT_WIDTH;
  return Math.round(Math.min(max, Math.max(THREAD_PANEL_MIN_WIDTH, width)));
}

interface ThreadPanelState {
  /** The open thread: one at a time, like Slack. */
  openConversationId: string | null;
  openRootMessageId: string | null;
  /** A reply to scroll to and highlight when the panel opens (search, links). */
  highlightMessageId: string | null;
  /** Bumped to focus the panel's composer (e.g. after "Reply in thread"). */
  focusNonce: number;
  width: number;
  widthLoaded: boolean;
  openThread: (
    conversationId: string,
    rootMessageId: string,
    options?: { focus?: boolean; highlightMessageId?: string | null },
  ) => void;
  closeThread: () => void;
  /** Close the panel when it shows a thread of another conversation. */
  closeIfNotIn: (conversationId: string) => void;
  setWidth: (width: number, persist?: boolean) => void;
  loadWidth: () => Promise<void>;
}

export const useThreadPanelStore = create<ThreadPanelState>()((set, get) => ({
  openConversationId: null,
  openRootMessageId: null,
  highlightMessageId: null,
  focusNonce: 0,
  width: THREAD_PANEL_DEFAULT_WIDTH,
  widthLoaded: false,

  openThread: (conversationId, rootMessageId, options = {}) =>
    set((state) => ({
      openConversationId: conversationId,
      openRootMessageId: rootMessageId,
      highlightMessageId: options.highlightMessageId ?? null,
      focusNonce: options.focus ? state.focusNonce + 1 : state.focusNonce,
    })),

  closeThread: () =>
    set({ openConversationId: null, openRootMessageId: null, highlightMessageId: null }),

  closeIfNotIn: (conversationId) => {
    const { openConversationId } = get();
    if (openConversationId && openConversationId !== conversationId) get().closeThread();
  },

  setWidth: (width, persist = false) => {
    const next = clampThreadPanelWidth(width);
    set({ width: next });
    if (persist) void preferences.set(WIDTH_KEY, String(next));
  },

  loadWidth: async () => {
    if (get().widthLoaded) return;
    const saved = await preferences.get(WIDTH_KEY).catch(() => null);
    set({
      widthLoaded: true,
      ...(saved ? { width: clampThreadPanelWidth(Number(saved)) } : {}),
    });
  },
}));

onSessionReset(() => useThreadPanelStore.getState().closeThread());
