import { eq } from "drizzle-orm";
import { db } from "../db";
import { messages, users } from "../db/schema";
import { processMessageMentions } from "../services/bot-runtime";
import {
  CHAT_MESSAGE_SENT_EVENT_TYPE,
  CHAT_MESSAGE_SENT_EVENT_VERSION,
  parseChatMessageSentV1,
  type ChatMessageSentV1,
} from "./envelope";
import type { DomainEventHandler } from "./registry";
import { logDomainEvent } from "./log";

export function createChatMessageSentHandler(): DomainEventHandler<ChatMessageSentV1> {
  return {
    type: CHAT_MESSAGE_SENT_EVENT_TYPE,
    version: CHAT_MESSAGE_SENT_EVENT_VERSION,
    parse: parseChatMessageSentV1,
    async handle(event) {
      const [message] = await db
        .select({
          id: messages.id,
          content: messages.content,
          conversationId: messages.conversationId,
          threadId: messages.threadId,
          senderId: messages.senderId,
          senderName: users.name,
          createdAt: messages.createdAt,
        })
        .from(messages)
        .innerJoin(users, eq(messages.senderId, users.id))
        .where(eq(messages.id, event.payload.messageId))
        .limit(1);

      if (!message) {
        logDomainEvent("warn", "domain_event.message_missing", event);
        return;
      }

      await processMessageMentions({
        id: message.id,
        content: message.content,
        conversationId: message.conversationId,
        threadId: message.threadId,
        senderId: message.senderId,
        senderName: message.senderName,
        createdAt: message.createdAt.toISOString(),
      });
    },
  };
}
