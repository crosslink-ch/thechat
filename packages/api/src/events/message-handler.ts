import { eq } from "drizzle-orm";
import { db } from "../db";
import { messages, users } from "../db/schema";
import { processMessageMentions } from "../services/bot-runtime";
import {
  CHAT_MESSAGE_SENT_EVENT_TYPE,
  CHAT_MESSAGE_SENT_EVENT_VERSION,
  MAX_BOT_AUTOMATION_DEPTH,
  parseChatMessageSentV1,
  type ChatMessageSentV1,
} from "./envelope";
import {
  PermanentDomainEventError,
  type DomainEventHandler,
} from "./registry";
import { logDomainEvent } from "./log";

export function createChatMessageSentHandler(): DomainEventHandler<ChatMessageSentV1> {
  return {
    type: CHAT_MESSAGE_SENT_EVENT_TYPE,
    version: CHAT_MESSAGE_SENT_EVENT_VERSION,
    parse: parseChatMessageSentV1,
    async handle(event) {
      if (event.payload.messageKind === "system_failure") {
        logDomainEvent("info", "domain_event.message_automation_suppressed", event, {
          reason: "system_failure",
        });
        return;
      }
      if (
        event.actor?.type === "bot" &&
        event.payload.automationDepth >= MAX_BOT_AUTOMATION_DEPTH
      ) {
        logDomainEvent("warn", "domain_event.message_automation_suppressed", event, {
          reason: "max_automation_depth",
          automationDepth: event.payload.automationDepth,
        });
        return;
      }

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
        logDomainEvent("error", "domain_event.message_missing", event);
        throw new PermanentDomainEventError(
          `Message ${event.payload.messageId} does not exist`,
        );
      }
      if (message.conversationId !== event.payload.conversationId) {
        throw new PermanentDomainEventError(
          `Message ${message.id} belongs to ${message.conversationId}, not ${event.payload.conversationId}`,
        );
      }

      await processMessageMentions({
        id: message.id,
        content: message.content,
        conversationId: message.conversationId,
        threadId: message.threadId,
        senderId: message.senderId,
        senderName: message.senderName,
        createdAt: message.createdAt.toISOString(),
        targetBotIds: event.payload.targetBotIds,
        automationDepth: event.payload.automationDepth,
        domainEventId: event.id,
        correlationId: event.correlationId ?? event.id,
      });
    },
  };
}
