import { useEffect, useRef, useSyncExternalStore } from "react";
import type { ChatMessage } from "@thechat/shared";
import { useActivityStore } from "../stores/activity";
import { useAuthStore } from "../stores/auth";
import { sessionGeneration } from "../lib/session-boundary";
import type { TaskReadSnapshot } from "./useChannelChat";

function subscribeVisibility(onChange: () => void) {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}

function pageVisible() {
  return typeof document === "undefined" || document.visibilityState !== "hidden";
}

/**
 * Persist rendered IDs, plus a task's fixed opening backlog once its view loads.
 * Deleting a timestamp/cursor range can consume an earlier transaction
 * that committed after the page snapshot, losing a message the user never saw.
 *
 * A hidden page (another tab focused, phone locked, app backgrounded) has not
 * shown the message to anyone, so it waits until the page is visible again.
 * Otherwise a forgotten open tab would mark everything read and silence the
 * phone's background notifications.
 */
export function usePersistConversationRead(
  conversationId: string | null,
  messages: ChatMessage[],
  enabled = true,
  taskView?: { threadId: string | null; snapshot: TaskReadSnapshot | null },
) {
  const markConversationRead = useActivityStore(
    (state) => state.markConversationRead,
  );
  const visible = useSyncExternalStore(subscribeVisibility, pageVisible, () => true);
  const snapshot = taskView?.snapshot;
  const taskThreadId = taskView?.threadId;
  const taskMode = taskView !== undefined;
  const openedScope = useRef<{
    scope: string;
    messageIds: string[];
    acknowledged: boolean;
  } | null>(null);
  const scope = JSON.stringify([conversationId, taskThreadId, sessionGeneration()]);
  // Switching scope or entering a draft ends the old opening. Returning to
  // General after a draft has the same scope ID but needs a fresh backlog.
  useEffect(() => { openedScope.current = null; }, [scope, enabled]);
  const renderedMessageIds = messages
    .filter((message) => message.conversationId === conversationId
      && (!taskMode || message.threadId === taskThreadId))
    .map((message) => message.id)
    .filter((id) => !id.startsWith("optimistic:"));
  const renderedMessageKey = renderedMessageIds.join(",");

  useEffect(() => {
    if (!enabled || !visible || !conversationId) return;
    if (taskMode && (!snapshot
      || snapshot.conversationId !== conversationId || snapshot.threadId !== taskThreadId
      || snapshot.generation !== sessionGeneration()
      || snapshot.token !== useAuthStore.getState().token
      || snapshot.userId !== useAuthStore.getState().user?.id)) return;
    if (taskMode && openedScope.current?.scope !== scope) {
      openedScope.current = {
        scope,
        messageIds: [...new Set([...snapshot!.messageIds, ...renderedMessageIds])],
        acknowledged: false,
      };
    }
    const opening = taskMode ? openedScope.current : null;
    const ids = [...new Set([
      ...(opening && !opening.acknowledged ? opening.messageIds : []),
      ...renderedMessageIds,
    ])];
    if (ids.length === 0) return;
    const pending = taskMode
      ? markConversationRead(conversationId, ids, taskThreadId)
      : markConversationRead(conversationId, ids);
    void pending.then(() => {
      if (opening) opening.acknowledged = true;
    }).catch(() => {
      // Retain this opening's exact IDs across retries. A refetch can include
      // newer, unrendered messages that were not part of the original view.
      // The activity store retains the error; a future event retries these IDs.
    });
    // The key is the stable identity of the exact rendered server message set.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, enabled, visible, markConversationRead, renderedMessageKey, taskMode, taskThreadId, snapshot, scope]);
}
