import { QueryClient } from "@tanstack/react-query";
import type { ChatMessage, MessageReactionSummary } from "@thechat/shared";
import { describe, expect, it, vi } from "vitest";
import {
  cacheMessageReactions,
  messagesQueryKey,
  optimisticallySetMessageReaction,
  reconcileMessageReactions,
} from "./useChannelChat";

const reactions: MessageReactionSummary[] = [
  {
    emoji: "🎉",
    count: 2,
    reactedByMe: true,
    userNames: ["Alice", "Bob"],
  },
];

describe("cacheMessageReactions", () => {
  it("updates every cached scope for the message conversation", () => {
    const client = new QueryClient();
    const message = chatMessage();
    const other = chatMessage({ id: "other-message" });
    const generalKey = messagesQueryKey("conversation-1", null, true);
    const threadKey = messagesQueryKey("conversation-1", "thread-1");
    const otherConversationKey = messagesQueryKey("conversation-2");

    client.setQueryData(generalKey, windowWith([message]));
    client.setQueryData(threadKey, windowWith([message]));
    client.setQueryData(otherConversationKey, windowWith([other]));

    cacheMessageReactions(
      client,
      "conversation-1",
      "message-1",
      reactions,
    );

    expect(firstMessage(client, generalKey).reactions).toEqual(reactions);
    expect(firstMessage(client, threadKey).reactions).toEqual(reactions);
    expect(firstMessage(client, otherConversationKey).reactions).toBeUndefined();
  });

  it("installs authoritative state without waiting for the background refetch", () => {
    const client = new QueryClient();
    const key = messagesQueryKey("conversation-1");
    client.setQueryData(key, windowWith([chatMessage()]));
    const invalidateQueries = vi
      .spyOn(client, "invalidateQueries")
      .mockImplementation(() => new Promise(() => {}));

    const result = reconcileMessageReactions(
      client,
      "conversation-1",
      "message-1",
      reactions,
    );

    expect(result).toBeUndefined();
    expect(firstMessage(client, key).reactions).toEqual(reactions);
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["messages", "conversation-1"],
    });
  });
});

describe("optimisticallySetMessageReaction", () => {
  it("removes my sole reaction synchronously and can restore it", () => {
    const client = new QueryClient();
    const key = messagesQueryKey("conversation-1");
    const previous: MessageReactionSummary[] = [
      {
        emoji: "👍",
        count: 1,
        reactedByMe: true,
        userNames: ["Bruno"],
      },
    ];
    client.setQueryData(key, windowWith([chatMessage({ reactions: previous })]));

    const rollback = optimisticallySetMessageReaction(
      client,
      "conversation-1",
      "message-1",
      "👍",
      false,
      "Bruno",
    );

    expect(firstMessage(client, key).reactions).toEqual([]);

    rollback();
    expect(firstMessage(client, key).reactions).toEqual(previous);
  });

  it("decrements my grouped reaction and preserves unrelated live changes on rollback", () => {
    const client = new QueryClient();
    const key = messagesQueryKey("conversation-1");
    const previous: MessageReactionSummary[] = [
      {
        emoji: "👍",
        count: 2,
        reactedByMe: true,
        userNames: ["Alice", "Bruno"],
      },
      ...reactions,
    ];
    client.setQueryData(key, windowWith([chatMessage({ reactions: previous })]));

    const rollback = optimisticallySetMessageReaction(
      client,
      "conversation-1",
      "message-1",
      "👍",
      false,
      "Bruno",
    );

    expect(firstMessage(client, key).reactions).toEqual([
      {
        emoji: "👍",
        count: 1,
        reactedByMe: false,
        userNames: ["Alice"],
      },
      ...reactions,
    ]);

    const liveReaction: MessageReactionSummary = {
      emoji: "🔥",
      count: 1,
      reactedByMe: false,
      userNames: ["Carol"],
    };
    cacheMessageReactions(client, "conversation-1", "message-1", [
      ...(firstMessage(client, key).reactions ?? []),
      liveReaction,
    ]);

    rollback();
    expect(firstMessage(client, key).reactions).toEqual([
      ...previous,
      liveReaction,
    ]);
  });

  it("adds my reaction synchronously", () => {
    const client = new QueryClient();
    const key = messagesQueryKey("conversation-1");
    client.setQueryData(key, windowWith([chatMessage({ reactions: [] })]));

    optimisticallySetMessageReaction(
      client,
      "conversation-1",
      "message-1",
      "🔥",
      true,
      "Bruno",
    );

    expect(firstMessage(client, key).reactions).toEqual([
      {
        emoji: "🔥",
        count: 1,
        reactedByMe: true,
        userNames: ["Bruno"],
      },
    ]);
  });

  it("keeps duplicate display names aligned with the reaction count", () => {
    const client = new QueryClient();
    const key = messagesQueryKey("conversation-1");
    client.setQueryData(
      key,
      windowWith([
        chatMessage({
          reactions: [
            {
              emoji: "👍",
              count: 1,
              reactedByMe: false,
              userNames: ["Bruno"],
            },
          ],
        }),
      ]),
    );

    optimisticallySetMessageReaction(
      client,
      "conversation-1",
      "message-1",
      "👍",
      true,
      "Bruno",
    );
    expect(firstMessage(client, key).reactions).toEqual([
      {
        emoji: "👍",
        count: 2,
        reactedByMe: true,
        userNames: ["Bruno", "Bruno"],
      },
    ]);

    optimisticallySetMessageReaction(
      client,
      "conversation-1",
      "message-1",
      "👍",
      false,
      "Bruno",
    );
    expect(firstMessage(client, key).reactions).toEqual([
      {
        emoji: "👍",
        count: 1,
        reactedByMe: false,
        userNames: ["Bruno"],
      },
    ]);
  });
});

function windowWith(messages: ChatMessage[]) {
  return {
    pages: [{ messages, hasOlder: false }],
    pageParams: [null],
  };
}

function firstMessage(client: QueryClient, key: readonly unknown[]) {
  return (client.getQueryData(key) as ReturnType<typeof windowWith>).pages[0]
    .messages[0];
}

function chatMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "message-1",
    conversationId: "conversation-1",
    threadId: null,
    senderId: "user-1",
    senderName: "Alice",
    senderType: "human",
    content: "Ship it",
    parts: null,
    attachments: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}
