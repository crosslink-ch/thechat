import { eq, and, lt, desc } from "drizzle-orm";
import { db } from "../db";
import {
  botSessions,
  messages,
  conversationParticipants,
  users,
} from "../db/schema";
import {
  getDefaultHermesBotSessionForConversation,
  processMessageMentions,
} from "./bot-runtime";
import { ServiceError } from "./errors";

export async function getMessages(
  conversationId: string,
  userId: string,
  options?: { limit?: number; before?: string; botSessionId?: string | null }
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
  if (options?.botSessionId) {
    await requireBotSessionInConversation(options.botSessionId, conversationId);
    conditions.push(eq(messages.botSessionId, options.botSessionId));
  }
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
  options: { botSessionId?: string | null } = {},
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

  let botSessionId = options.botSessionId ?? null;
  if (botSessionId) {
    await requireBotSessionInConversation(botSessionId, conversationId);
  } else {
    const defaultHermesSession = await getDefaultHermesBotSessionForConversation(conversationId, userId);
    botSessionId = defaultHermesSession?.id ?? null;
  }

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
}

async function requireBotSessionInConversation(botSessionId: string, conversationId: string) {
  const [session] = await db
    .select({ id: botSessions.id })
    .from(botSessions)
    .where(and(eq(botSessions.id, botSessionId), eq(botSessions.conversationId, conversationId)))
    .limit(1);
  if (!session) throw new ServiceError("Hermes session not found", 404);
}
