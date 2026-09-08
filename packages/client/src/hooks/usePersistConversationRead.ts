import { useEffect } from "react";
import type { ChatMessage } from "@thechat/shared";
import { useActivityStore } from "../stores/activity";

/**
 * Persist only server message IDs that are actually present in the rendered
 * view. Deleting a timestamp/cursor range can consume an earlier transaction
 * that committed after the page snapshot, losing a message the user never saw.
 */
export function usePersistConversationRead(
  conversationId: string | null,
  messages: ChatMessage[],
  enabled = true,
) {
  const markConversationRead = useActivityStore(
    (state) => state.markConversationRead,
  );
  const renderedMessageIds = messages
    .map((message) => message.id)
    .filter((id) => !id.startsWith("optimistic:"));
  const renderedMessageKey = renderedMessageIds.join(",");

  useEffect(() => {
    if (!enabled || !conversationId || renderedMessageIds.length === 0) return;
    void markConversationRead(conversationId, renderedMessageIds).catch(() => {
      // The activity store retains a user-visible error and a future snapshot
      // or realtime event will retry reconciliation.
    });
    // The key is the stable identity of the exact rendered server message set.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, enabled, markConversationRead, renderedMessageKey]);
}
