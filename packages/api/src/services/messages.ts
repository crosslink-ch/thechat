import { eq, and, lt, desc } from "drizzle-orm";
import { db } from "../db";
import {
  messages,
  conversationParticipants,
  users,
} from "../db/schema";
import {
  getDefaultHermesContinuityForConversation,
  processMessageMentions,
} from "./bot-runtime";
import { ServiceError } from "./errors";
import { withSpan } from "../observability";

export async function getMessages(
  conversationId: string,
  userId: string,
  options?: { limit?: number; before?: string }
) {
  // Validate user is a participant
  const [participant] = await db
    .select()
    .from(conversationParticipants)
    .where(
      and(
        eq(conversationParticipants.conversationId, conversationId),
        eq(conversationParticipants.userId, userId)
      )
    )
    .limit(1);

  if (!participant) {
    throw new ServiceError(
      "You are not a participant of this conversation",
      403
    );
  }

  const limit = Math.min(options?.limit || 50, 100);
  const conditions = [eq(messages.conversationId, conversationId)];
  if (options?.before) {
    conditions.push(lt(messages.createdAt, new Date(options.before)));
  }

  const rows = await db
    .select({
      id: messages.id,
      conversationId: messages.conversationId,
      botSessionId: messages.botSessionId,
      senderId: messages.senderId,
      content: messages.content,
      parts: messages.parts,
      createdAt: messages.createdAt,
      senderName: users.name,
      senderType: users.type,
    })
    .from(messages)
    .innerJoin(users, eq(messages.senderId, users.id))
    .where(and(...conditions))
    .orderBy(desc(messages.createdAt))
    .limit(limit);

  // Return in chronological order
  return rows.reverse().map((r) => ({
    id: r.id,
    conversationId: r.conversationId,
    botSessionId: r.botSessionId,
    senderId: r.senderId,
    senderName: r.senderName,
    senderType: r.senderType,
    content: r.content,
    parts: r.parts ?? null,
    createdAt: r.createdAt.toISOString(),
  }));
}

export async function sendMessage(
  conversationId: string,
  userId: string,
  userName: string,
  content: string,
) {
  return withSpan(
    "message.send",
    {
      "messaging.system": "thechat",
      "messaging.operation": "send",
      "thechat.conversation_id": conversationId,
      "thechat.user_id": userId,
    },
    async (span) => {
      // Validate user is a participant
      const [participant] = await db
        .select()
        .from(conversationParticipants)
        .where(
          and(
            eq(conversationParticipants.conversationId, conversationId),
            eq(conversationParticipants.userId, userId)
          )
        )
        .limit(1);

      if (!participant) {
        throw new ServiceError(
          "You are not a participant of this conversation",
          403
        );
      }

      const hermesContinuity = await getDefaultHermesContinuityForConversation(conversationId, userId);
      const botSessionId = hermesContinuity?.id ?? null;
      span.setAttribute("thechat.bot_context_id", botSessionId ?? "");
      span.setAttribute("thechat.hermes_continuity.auto_attached", Boolean(botSessionId));

      const [msg] = await db
        .insert(messages)
        .values({
          conversationId,
          botSessionId,
          senderId: userId,
          content,
        })
        .returning();

      const createdAt = msg.createdAt.toISOString();
      span.setAttribute("thechat.message_id", msg.id);

      // Fire-and-forget bot invocation detection for mentioned bots and Hermes DMs.
      processMessageMentions({
        id: msg.id,
        content: msg.content,
        conversationId: msg.conversationId,
        botSessionId: msg.botSessionId,
        senderId: msg.senderId,
        senderName: userName,
        createdAt,
      }).catch((error) => console.error("Failed to enqueue bot invocation", error));

      return {
        id: msg.id,
        conversationId: msg.conversationId,
        botSessionId: msg.botSessionId,
        senderId: msg.senderId,
        senderName: userName,
        senderType: "human" as const,
        content: msg.content,
        parts: msg.parts ?? null,
        createdAt,
      };
    },
  );
}
