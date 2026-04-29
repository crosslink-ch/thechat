import { eq, and, lt, desc } from "drizzle-orm";
import { db } from "../db";
import {
  messages,
  conversationParticipants,
  users,
} from "../db/schema";
import { processBotEvents } from "../bots/webhooks";
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
    createdAt: r.createdAt.toISOString(),
  }));
}

export async function sendMessage(
  conversationId: string,
  userId: string,
  userName: string,
  content: string
) {
  // Validate user is a participant — also recover their type so we can include
  // it in webhook/WS payloads (clients use it for bot badging, plugins use it
  // for bot-loop prevention).
  const [participant] = await db
    .select({ userType: users.type })
    .from(conversationParticipants)
    .innerJoin(users, eq(users.id, conversationParticipants.userId))
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

  const senderType = participant.userType;

  const [msg] = await db
    .insert(messages)
    .values({
      conversationId,
      senderId: userId,
      content,
    })
    .returning();

  const createdAt = msg.createdAt.toISOString();

  // Fire-and-forget bot event delivery (mentions in channels, every message
  // in DMs). Errors are logged inside processBotEvents and never bubble.
  void processBotEvents({
    id: msg.id,
    content: msg.content,
    conversationId: msg.conversationId,
    senderId: msg.senderId,
    senderName: userName,
    senderType,
    createdAt,
  });

  return {
    id: msg.id,
    conversationId: msg.conversationId,
    senderId: msg.senderId,
    senderName: userName,
    senderType,
    content: msg.content,
    createdAt,
  };
}
