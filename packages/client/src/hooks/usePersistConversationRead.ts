import { useEffect, useSyncExternalStore } from "react";
import type { ChatMessage } from "@thechat/shared";
import { useActivityStore } from "../stores/activity";

function subscribeVisibility(onChange: () => void) {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}

function pageVisible() {
  return typeof document === "undefined" || document.visibilityState !== "hidden";
}

/**
 * Persist only server message IDs that are actually present in the rendered
 * view. Deleting a timestamp/cursor range can consume an earlier transaction
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
) {
  const markConversationRead = useActivityStore(
    (state) => state.markConversationRead,
  );
  const visible = useSyncExternalStore(subscribeVisibility, pageVisible, () => true);
  const renderedMessageIds = messages
    .map((message) => message.id)
    .filter((id) => !id.startsWith("optimistic:"));
  const renderedMessageKey = renderedMessageIds.join(",");

  useEffect(() => {
    if (!enabled || !visible || !conversationId || renderedMessageIds.length === 0) return;
    void markConversationRead(conversationId, renderedMessageIds).catch(() => {
      // The activity store retains a user-visible error and a future snapshot
      // or realtime event will retry reconciliation.
    });
    // The key is the stable identity of the exact rendered server message set.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, enabled, visible, markConversationRead, renderedMessageKey]);
}
