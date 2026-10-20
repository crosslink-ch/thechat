import { useEffect, useMemo } from "react";
import type { BotRequestPublic, ChatMessage } from "@thechat/shared";
import { BotRequestCard } from "./BotRequestCard";
import {
  blockedRequestIds,
  compareRequests,
  useBotRequestAnswerer,
  useBotRequestsStore,
  useConversationBotRequests,
} from "../stores/bot-requests";
import { useWebSocketStore } from "../stores/websocket";

/**
 * Which requests a view shows. `threadId === undefined` takes every request
 * in the conversation (channels); `null` only unthreaded ones; a string only
 * that thread's.
 */
export interface BotRequestScope {
  conversationId: string;
  threadId?: string | null;
}

/** Where each request goes in a message list. */
export interface BotRequestTimeline {
  /** Requests rendered directly before the message with this id. */
  beforeMessage: ReadonlyMap<string, BotRequestPublic[]>;
  /** Requests newer than every loaded message; rendered after live activity. */
  trailing: BotRequestPublic[];
  blocked: ReadonlySet<string>;
}

const NO_REQUESTS: BotRequestTimeline = {
  beforeMessage: new Map(),
  trailing: [],
  blocked: new Set(),
};

/**
 * Bot requests placed in the message timeline at the time they were asked, so
 * an answered question stays next to the conversation it belonged to instead
 * of trailing below newer messages. Rows come from PostgreSQL and are
 * reloaded on open and after every reconnect, so a missed
 * `bot_request_updated` push cannot leave a stale card behind.
 */
export function useBotRequestTimeline({
  scope,
  messages,
  hasOlderMessages = false,
  enabled = true,
}: {
  scope: BotRequestScope | null | undefined;
  messages: ChatMessage[];
  hasOlderMessages?: boolean;
  /** False while messages load, so requests do not flash at the bottom first. */
  enabled?: boolean;
}): BotRequestTimeline {
  const conversationId = scope?.conversationId ?? null;
  const threadId = scope?.threadId;
  const fetchConversation = useBotRequestsStore((state) => state.fetchConversation);
  const connected = useWebSocketStore((state) => state.connected);
  const all = useConversationBotRequests(conversationId);
  const local = useBotRequestAnswerer().local === true;

  useEffect(() => {
    if (!conversationId || !connected || local) return;
    void fetchConversation(conversationId);
  }, [connected, conversationId, fetchConversation, local]);

  return useMemo(() => {
    if (!enabled || !conversationId) return NO_REQUESTS;
    const scoped = all.filter((request) =>
      threadId === undefined ? true : request.threadId === threadId,
    );
    if (scoped.length === 0) return NO_REQUESTS;
    return {
      ...placeBotRequests(scoped, messages, hasOlderMessages),
      blocked: blockedRequestIds(all),
    };
  }, [all, conversationId, enabled, hasOlderMessages, messages, threadId]);
}

/**
 * Anchors each request before the first message sent after it was asked.
 * Requests asked after the last loaded message trail the list. Requests asked
 * before the loaded history window wait for that history to load, except open
 * ones, which stay reachable at the bottom.
 */
export function placeBotRequests(
  requests: BotRequestPublic[],
  messages: ChatMessage[],
  hasOlderMessages: boolean,
): Pick<BotRequestTimeline, "beforeMessage" | "trailing"> {
  const beforeMessage = new Map<string, BotRequestPublic[]>();
  const trailing: BotRequestPublic[] = [];
  const firstMessageAt =
    messages.length > 0 ? Date.parse(messages[0].createdAt) : Number.NaN;
  let index = 0;
  for (const request of [...requests].sort(compareRequests)) {
    const askedAt = Date.parse(request.createdAt);
    if (!Number.isFinite(askedAt)) {
      trailing.push(request);
      continue;
    }
    if (hasOlderMessages && Number.isFinite(firstMessageAt) && askedAt < firstMessageAt) {
      if (request.status === "open") trailing.push(request);
      continue;
    }
    while (
      index < messages.length &&
      !(Date.parse(messages[index].createdAt) > askedAt)
    ) {
      index += 1;
    }
    if (index >= messages.length) {
      trailing.push(request);
      continue;
    }
    const anchorId = messages[index].id;
    const anchored = beforeMessage.get(anchorId);
    if (anchored) anchored.push(request);
    else beforeMessage.set(anchorId, [request]);
  }
  return { beforeMessage, trailing };
}

/** Request rows for one slot of the timeline, aligned with message content. */
export function BotRequestTimelineItems({
  requests,
  blocked,
}: {
  requests: readonly BotRequestPublic[] | undefined;
  blocked: ReadonlySet<string>;
}) {
  if (!requests || requests.length === 0) return null;
  return (
    <>
      {requests.map((request) => (
        <BotRequestCard
          key={request.id}
          request={request}
          blocked={blocked.has(request.id)}
          layout="timeline"
        />
      ))}
    </>
  );
}
