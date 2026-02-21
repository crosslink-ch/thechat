import { Elysia } from "elysia";
import { eq, and, lt, desc } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import {
  messages,
  conversationParticipants,
  users,
} from "../db/schema";
import { resolveTokenToUser } from "../auth/middleware";
import { processMessageMentions } from "../bots/webhooks";

const sendSchema = z.object({
  content: z.string().trim().min(1),
});

export const messageRoutes = new Elysia({ prefix: "/messages" })
  .derive(async ({ headers }) => {
    const authHeader = headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      return { user: null } as any;
    }

    const token = authHeader.slice(7);
    const user = await resolveTokenToUser(token);
    if (!user) return { user: null } as any;
    return { user };
  })
  .onBeforeHandle(({ user, set }) => {
    if (!user) {
      set.status = 401;
      return { error: "Authentication required" };
    }
  })

  // Fetch messages (paginated)
  .get("/:conversationId", async ({ params, query, user, set }) => {
    const { conversationId } = params;
    const limit = Math.min(Number(query.limit) || 50, 100);
    const before = query.before as string | undefined;

    // Validate user is a participant
    const [participant] = await db
      .select()
      .from(conversationParticipants)
      .where(
        and(
          eq(conversationParticipants.conversationId, conversationId),
          eq(conversationParticipants.userId, user.id)
        )
      )
      .limit(1);

    if (!participant) {
      set.status = 403;
      return { error: "You are not a participant of this conversation" };
    }

    const conditions = [eq(messages.conversationId, conversationId)];
    if (before) {
      conditions.push(lt(messages.createdAt, new Date(before)));
    }

    const rows = await db
      .select({
        id: messages.id,
        conversationId: messages.conversationId,
        senderId: messages.senderId,
        content: messages.content,
        createdAt: messages.createdAt,
        senderName: users.name,
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
      content: r.content,
      createdAt: r.createdAt.toISOString(),
    }));
  })

  // Send a message (REST fallback)
  .post("/:conversationId", async ({ params, body, user, set }) => {
    const { conversationId } = params;

    const parsed = sendSchema.safeParse(body);
    if (!parsed.success) {
      set.status = 400;
      return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
    }

    // Validate user is a participant
    const [participant] = await db
      .select()
      .from(conversationParticipants)
      .where(
        and(
          eq(conversationParticipants.conversationId, conversationId),
          eq(conversationParticipants.userId, user.id)
        )
      )
      .limit(1);

    if (!participant) {
      set.status = 403;
      return { error: "You are not a participant of this conversation" };
    }

    const [msg] = await db
      .insert(messages)
      .values({
        conversationId,
        senderId: user.id,
        content: parsed.data.content,
      })
      .returning();

    const createdAt = msg.createdAt.toISOString();

    // Fire-and-forget webhook notifications for @mentioned bots
    processMessageMentions({
      id: msg.id,
      content: msg.content,
      conversationId: msg.conversationId,
      senderId: msg.senderId,
      senderName: user.name,
      createdAt,
    });

    return {
      id: msg.id,
      conversationId: msg.conversationId,
      senderId: msg.senderId,
      senderName: user.name,
      content: msg.content,
      createdAt,
    };
  });
