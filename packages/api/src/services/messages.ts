import { eq, and, lt, desc } from "drizzle-orm";
import { db } from "../db";
import {
  messages,
  conversationParticipants,
  users,
} from "../db/schema";
import { processMessageMentions } from "../bots/webhooks";
import { ServiceError } from "./errors";

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
  content: string
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

  const [msg] = await db
    .insert(messages)
    .values({
      conversationId,
      senderId: userId,
      content,
    })
    .returning();

  const createdAt = msg.createdAt.toISOString();

  // Fire-and-forget webhook notifications for @mentioned bots
  processMessageMentions({
    id: msg.id,
    content: msg.content,
    conversationId: msg.conversationId,
    senderId: msg.senderId,
    senderName: userName,
    createdAt,
  });

  return {
    id: msg.id,
    conversationId: msg.conversationId,
    senderId: msg.senderId,
    senderName: userName,
    senderType: "human" as const,
    content: msg.content,
    parts: msg.parts ?? null,
    createdAt,
  };
}
