import { QueryClient } from "@tanstack/react-query";
import type { ChatMessage, MessageReactionSummary } from "@thechat/shared";
import { describe, expect, it, vi } from "vitest";
import {
  cacheMessageReactions,
  messagesQueryKey,
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

  it("invalidates authoritative message state after installing a mutation snapshot", async () => {
    const client = new QueryClient();
    const key = messagesQueryKey("conversation-1");
    client.setQueryData(key, windowWith([chatMessage()]));
    const invalidateQueries = vi
      .spyOn(client, "invalidateQueries")
      .mockImplementation(async () => {
        expect(firstMessage(client, key).reactions).toEqual(reactions);
      });

    await reconcileMessageReactions(
      client,
      "conversation-1",
      "message-1",
      reactions,
    );

    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["messages", "conversation-1"],
    });
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
