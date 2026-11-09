import { useCallback, useEffect, useMemo } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useActivityStore } from "../stores/activity";
import { useThreadPanelStore } from "../stores/thread-panel";

/**
 * Route-side state of the reply-thread side panel for one conversation:
 * which thread is open, which roots have unread replies, and an opener for
 * message rows. A `replyThread` search parameter (links, notifications,
 * search results) opens a thread when the conversation loads.
 */
export function useReplyThreadPanel(
  conversationId: string,
  options: {
    enabled?: boolean;
    requestedRootId?: string;
    requestedHighlightId?: string;
    routeTo: "/channel/$id" | "/dm/$id";
  },
) {
  const enabled = options.enabled ?? true;
  const navigate = useNavigate();
  const openConversationId = useThreadPanelStore((state) => state.openConversationId);
  const openRootId = useThreadPanelStore((state) => state.openRootMessageId);
  const openThread = useThreadPanelStore((state) => state.openThread);
  const closeIfNotIn = useThreadPanelStore((state) => state.closeIfNotIn);
  const threads = useActivityStore((state) => state.threads);

  // A panel belongs to one conversation: leaving it closes the panel.
  useEffect(() => {
    closeIfNotIn(conversationId);
  }, [closeIfNotIn, conversationId]);
  useEffect(() => {
    if (!enabled) useThreadPanelStore.getState().closeIfNotIn("");
  }, [enabled]);
  useEffect(
    () => () => {
      if (useThreadPanelStore.getState().openConversationId === conversationId) {
        useThreadPanelStore.getState().closeThread();
      }
    },
    [conversationId],
  );

  // Deep links: open once, then drop the parameter so closing sticks.
  const { requestedRootId, requestedHighlightId, routeTo } = options;
  useEffect(() => {
    if (!enabled || !requestedRootId) return;
    openThread(conversationId, requestedRootId, {
      highlightMessageId: requestedHighlightId ?? null,
    });
    void navigate({
      to: routeTo,
      params: { id: conversationId },
      search: (previous: Record<string, unknown>) => ({
        ...previous,
        replyThread: undefined,
        replyMessage: undefined,
      }),
      replace: true,
    } as never);
  }, [conversationId, enabled, navigate, openThread, requestedHighlightId, requestedRootId, routeTo]);

  const onOpenThread = useCallback(
    (rootMessageId: string, openOptions?: { focus?: boolean }) =>
      openThread(conversationId, rootMessageId, { focus: openOptions?.focus }),
    [conversationId, openThread],
  );

  const unreadThreadRootIds = useMemo(
    () =>
      new Set(
        threads
          .filter((thread) => thread.conversationId === conversationId)
          .map((thread) => thread.rootMessageId),
      ),
    [conversationId, threads],
  );

  const activeRootId = enabled && openConversationId === conversationId ? openRootId : null;
  return {
    openThreadRootId: activeRootId,
    onOpenThread: enabled ? onOpenThread : undefined,
    unreadThreadRootIds,
  };
}
