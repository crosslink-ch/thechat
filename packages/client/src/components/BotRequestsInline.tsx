import { useEffect, useMemo } from "react";
import type { BotRequestPublic } from "@thechat/shared";
import { BotRequestCard } from "./BotRequestCard";
import {
  blockedRequestIds,
  useBotRequestAnswerer,
  useBotRequestsStore,
  useConversationBotRequests,
} from "../stores/bot-requests";
import { useWebSocketStore } from "../stores/websocket";

/**
 * Requests asked in one conversation scope, rendered from request rows. They
 * stay visible after the run ends; resolved ones collapse to a single line.
 *
 * `threadId === undefined` shows every request in the conversation (channels);
 * `null` shows only unthreaded ones; a string shows that thread's.
 */
export function BotRequestsInline({
  conversationId,
  threadId,
  resolvedLimit = 5,
}: {
  conversationId: string;
  threadId?: string | null;
  resolvedLimit?: number;
}) {
  const fetchConversation = useBotRequestsStore((state) => state.fetchConversation);
  const connected = useWebSocketStore((state) => state.connected);
  const all = useConversationBotRequests(conversationId);
  const local = useBotRequestAnswerer().local === true;

  // Reload from PostgreSQL on open and after every reconnect, so a missed
  // `bot_request_updated` push cannot leave a stale card behind.
  useEffect(() => {
    if (!connected || local) return;
    void fetchConversation(conversationId);
  }, [connected, conversationId, fetchConversation, local]);

  const { visible, blocked } = useMemo(() => {
    const scoped = all.filter((request) =>
      threadId === undefined ? true : request.threadId === threadId,
    );
    const open = scoped.filter((request) => request.status === "open");
    const resolved = scoped
      .filter((request) => request.status !== "open")
      .slice(-resolvedLimit);
    const shown = [...resolved, ...open].sort(
      (left, right) =>
        Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
        left.id.localeCompare(right.id),
    );
    return { visible: shown, blocked: blockedRequestIds(all) };
  }, [all, resolvedLimit, threadId]);

  if (visible.length === 0) return null;
  return (
    <div data-testid="bot-requests-inline" className="flex flex-col gap-2 px-5 py-2">
      {visible.map((request: BotRequestPublic) => (
        <BotRequestCard
          key={request.id}
          request={request}
          blocked={blocked.has(request.id)}
        />
      ))}
    </div>
  );
}
