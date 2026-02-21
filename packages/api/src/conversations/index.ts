import { Elysia } from "elysia";
import { eq, and, gt, desc } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import {
  conversations,
  conversationParticipants,
  messages,
  users,
  sessions,
  workspaceMembers,
} from "../db/schema";

const dmSchema = z.object({
  workspaceId: z.string().trim().min(1),
  otherUserId: z.string().uuid(),
});

const channelSchema = z.object({
  workspaceId: z.string().trim().min(1),
  name: z.string().trim().min(1).max(100),
});

export const conversationRoutes = new Elysia({ prefix: "/conversations" })
  .derive(async ({ headers }) => {
    const authHeader = headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      return { user: null } as any;
    }

    const token = authHeader.slice(7);
    const [session] = await db
      .select()
      .from(sessions)
      .where(and(eq(sessions.token, token), gt(sessions.expiresAt, new Date())))
      .limit(1);

    if (!session) {
      return { user: null } as any;
    }

    const [user] = await db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        avatar: users.avatar,
      })
      .from(users)
      .where(eq(users.id, session.userId))
      .limit(1);

    if (!user) {
      return { user: null } as any;
    }

    return { user };
  })
  .onBeforeHandle(({ user, set }) => {
    if (!user) {
      set.status = 401;
      return { error: "Authentication required" };
    }
  })

  // Create or get existing DM between two users in a workspace
  .post("/dm", async ({ body, user, set }) => {
    const parsed = dmSchema.safeParse(body);
    if (!parsed.success) {
      set.status = 400;
      return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
    }

    const { workspaceId, otherUserId } = parsed.data;

    if (otherUserId === user.id) {
      set.status = 400;
      return { error: "Cannot create DM with yourself" };
    }

    // Check both users are workspace members
    const memberCheck = await db
      .select({ userId: workspaceMembers.userId })
      .from(workspaceMembers)
      .where(eq(workspaceMembers.workspaceId, workspaceId));

    const memberIds = new Set(memberCheck.map((m) => m.userId));
    if (!memberIds.has(user.id) || !memberIds.has(otherUserId)) {
      set.status = 403;
      return { error: "Both users must be workspace members" };
    }

    // Check if DM already exists between these two users in this workspace
    const myDmConvos = await db
      .select({ conversationId: conversationParticipants.conversationId })
      .from(conversationParticipants)
      .where(eq(conversationParticipants.userId, user.id));

    for (const { conversationId } of myDmConvos) {
      const [conv] = await db
        .select()
        .from(conversations)
        .where(
          and(
            eq(conversations.id, conversationId),
            eq(conversations.type, "direct"),
            eq(conversations.workspaceId, workspaceId)
          )
        )
        .limit(1);

      if (!conv) continue;

      // Check if other user is also a participant
      const [otherParticipant] = await db
        .select()
        .from(conversationParticipants)
        .where(
          and(
            eq(conversationParticipants.conversationId, conversationId),
            eq(conversationParticipants.userId, otherUserId)
          )
        )
        .limit(1);

      if (otherParticipant) {
        // DM already exists, return it
        const [otherUser] = await db
          .select({ id: users.id, name: users.name, email: users.email, avatar: users.avatar })
          .from(users)
          .where(eq(users.id, otherUserId))
          .limit(1);

        return {
          id: conv.id,
          otherUser: otherUser!,
          lastMessage: null,
        };
      }
    }

    // Create new DM conversation
    const [otherUser] = await db
      .select({ id: users.id, name: users.name, email: users.email, avatar: users.avatar })
      .from(users)
      .where(eq(users.id, otherUserId))
      .limit(1);

    if (!otherUser) {
      set.status = 404;
      return { error: "User not found" };
    }

    const [conv] = await db
      .insert(conversations)
      .values({
        type: "direct",
        workspaceId,
      })
      .returning();

    await db.insert(conversationParticipants).values([
      { conversationId: conv.id, userId: user.id, role: "member" as const },
      { conversationId: conv.id, userId: otherUserId, role: "member" as const },
    ]);

    return {
      id: conv.id,
      otherUser,
      lastMessage: null,
    };
  })

  // Create a new channel
  .post("/channel", async ({ body, user, set }) => {
    const parsed = channelSchema.safeParse(body);
    if (!parsed.success) {
      set.status = 400;
      return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
    }

    const { workspaceId, name } = parsed.data;

    // Check user is workspace member
    const [membership] = await db
      .select()
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.userId, user.id)
        )
      )
      .limit(1);

    if (!membership) {
      set.status = 403;
      return { error: "You are not a member of this workspace" };
    }

    // Create channel
    const slug = name
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-");

    const [channel] = await db
      .insert(conversations)
      .values({
        title: name,
        type: "group",
        workspaceId,
        name: slug,
      })
      .returning();

    // Add all workspace members as participants
    const allMembers = await db
      .select({ userId: workspaceMembers.userId })
      .from(workspaceMembers)
      .where(eq(workspaceMembers.workspaceId, workspaceId));

    if (allMembers.length > 0) {
      await db.insert(conversationParticipants).values(
        allMembers.map((m) => ({
          conversationId: channel.id,
          userId: m.userId,
          role: "member" as const,
        }))
      );
    }

    return {
      id: channel.id,
      workspaceId: channel.workspaceId,
      name: channel.name,
      title: channel.title,
      createdAt: channel.createdAt.toISOString(),
      updatedAt: channel.updatedAt.toISOString(),
    };
  })

  // List DM conversations for current user in a workspace
  .get("/:workspaceId/dms", async ({ params, user, set }) => {
    const { workspaceId } = params;

    // Check user is workspace member
    const [membership] = await db
      .select()
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.userId, user.id)
        )
      )
      .limit(1);

    if (!membership) {
      set.status = 403;
      return { error: "You are not a member of this workspace" };
    }

    // Get all DM conversations the user is in for this workspace
    const myParticipations = await db
      .select({
        conversationId: conversationParticipants.conversationId,
      })
      .from(conversationParticipants)
      .where(eq(conversationParticipants.userId, user.id));

    const results = [];

    for (const { conversationId } of myParticipations) {
      const [conv] = await db
        .select()
        .from(conversations)
        .where(
          and(
            eq(conversations.id, conversationId),
            eq(conversations.type, "direct"),
            eq(conversations.workspaceId, workspaceId)
          )
        )
        .limit(1);

      if (!conv) continue;

      // Get the other user
      const otherParticipants = await db
        .select({ userId: conversationParticipants.userId })
        .from(conversationParticipants)
        .where(
          eq(conversationParticipants.conversationId, conversationId)
        );

      const otherUserId = otherParticipants.find((p) => p.userId !== user.id)?.userId;
      if (!otherUserId) continue;

      const [otherUser] = await db
        .select({ id: users.id, name: users.name, email: users.email, avatar: users.avatar })
        .from(users)
        .where(eq(users.id, otherUserId))
        .limit(1);

      if (!otherUser) continue;

      // Get last message
      const [lastMsg] = await db
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
        .where(eq(messages.conversationId, conversationId))
        .orderBy(desc(messages.createdAt))
        .limit(1);

      results.push({
        id: conv.id,
        otherUser,
        lastMessage: lastMsg
          ? {
              id: lastMsg.id,
              conversationId: lastMsg.conversationId,
              senderId: lastMsg.senderId,
              senderName: lastMsg.senderName,
              content: lastMsg.content,
              createdAt: lastMsg.createdAt.toISOString(),
            }
          : null,
      });
    }

    return results;
  });
