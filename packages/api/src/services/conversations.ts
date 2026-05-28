import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import {
  bots,
  conversations,
  conversationParticipants,
  conversationThreads,
  messages,
  users,
  workspaceMembers,
} from "../db/schema";
import { ServiceError } from "./errors";

export async function createOrGetDm(
  workspaceId: string,
  userId: string,
  otherUserId: string
) {
  if (otherUserId === userId) {
    throw new ServiceError("Cannot create DM with yourself", 400);
  }

  // Check both users are workspace members
  const memberCheck = await db
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.workspaceId, workspaceId));

  const memberIds = new Set(memberCheck.map((m) => m.userId));
  if (!memberIds.has(userId) || !memberIds.has(otherUserId)) {
    throw new ServiceError("Both users must be workspace members", 403);
  }

  await repairCorruptedDirectDms(workspaceId, userId);

  // Check if DM already exists between these two users in this workspace
  const myDmConvos = await db
    .select({ conversationId: conversationParticipants.conversationId })
    .from(conversationParticipants)
    .where(eq(conversationParticipants.userId, userId));

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

    // A direct conversation must be exactly this pair. Older builds could
    // accidentally add workspace bots to existing DMs, so do not reuse a
    // direct conversation that has extra participants.
    const participants = await db
      .select({ userId: conversationParticipants.userId })
      .from(conversationParticipants)
      .where(eq(conversationParticipants.conversationId, conversationId));

    const participantIds = new Set(participants.map((p) => p.userId));
    const isExactDm =
      participantIds.size === 2 &&
      participantIds.has(userId) &&
      participantIds.has(otherUserId);

    if (isExactDm) {
      // DM already exists, return it
      const [otherUser] = await db
        .select({
          id: users.id,
          name: users.name,
          email: users.email,
          avatar: users.avatar,
          type: users.type,
          botId: bots.id,
          botKind: bots.kind,
        })
        .from(users)
        .leftJoin(bots, eq(bots.userId, users.id))
        .where(eq(users.id, otherUserId))
        .limit(1);

      return {
        id: conv.id,
        otherUser: {
          id: otherUser!.id,
          name: otherUser!.name,
          email: otherUser!.email,
          avatar: otherUser!.avatar,
          type: otherUser!.type,
        },
        otherBot: otherUser?.botId ? { id: otherUser.botId, kind: otherUser.botKind! } : null,
        lastMessage: null,
      };
    }
  }

  // Create new DM conversation
  const [otherUser] = await db
    .select({
    id: users.id,
    name: users.name,
    email: users.email,
    avatar: users.avatar,
    type: users.type,
    botId: bots.id,
    botKind: bots.kind,
  })
  .from(users)
  .leftJoin(bots, eq(bots.userId, users.id))
  .where(eq(users.id, otherUserId))
  .limit(1);

  if (!otherUser) {
    throw new ServiceError("User not found", 404);
  }

  const [conv] = await db
    .insert(conversations)
    .values({
      type: "direct",
      workspaceId,
    })
    .returning();

  await db.insert(conversationParticipants).values([
    { conversationId: conv.id, userId, role: "member" as const },
    { conversationId: conv.id, userId: otherUserId, role: "member" as const },
  ]);

  return {
    id: conv.id,
    otherUser: {
      id: otherUser.id,
      name: otherUser.name,
      email: otherUser.email,
      avatar: otherUser.avatar,
      type: otherUser.type,
    },
    otherBot: otherUser.botId ? { id: otherUser.botId, kind: otherUser.botKind! } : null,
    lastMessage: null,
  };
}

export async function listUserDms(workspaceId: string, userId: string) {
  // Check user is workspace member
  const [membership] = await db
    .select()
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, userId)
      )
    )
    .limit(1);

  if (!membership) {
    throw new ServiceError("You are not a member of this workspace", 403);
  }

  // Get all DM conversations the user is in for this workspace
  const myParticipations = await db
    .select({
      conversationId: conversationParticipants.conversationId,
    })
    .from(conversationParticipants)
    .where(eq(conversationParticipants.userId, userId));

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
      .where(eq(conversationParticipants.conversationId, conversationId));

    if (otherParticipants.length !== 2) continue;

    const otherUserId = otherParticipants.find((p) => p.userId !== userId)?.userId;
    if (!otherUserId) continue;

    const [otherUser] = await db
      .select({
      id: users.id,
      name: users.name,
      email: users.email,
      avatar: users.avatar,
      type: users.type,
      botId: bots.id,
      botKind: bots.kind,
    })
    .from(users)
    .leftJoin(bots, eq(bots.userId, users.id))
    .where(eq(users.id, otherUserId))
    .limit(1);

    if (!otherUser) continue;

    // Get last message
    const [lastMsg] = await db
      .select({
        id: messages.id,
        conversationId: messages.conversationId,
        threadId: messages.threadId,
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
      otherUser: {
        id: otherUser.id,
        name: otherUser.name,
        email: otherUser.email,
        avatar: otherUser.avatar,
        type: otherUser.type,
      },
      otherBot: otherUser.botId ? { id: otherUser.botId, kind: otherUser.botKind! } : null,
      lastMessage: lastMsg
        ? {
            id: lastMsg.id,
            conversationId: lastMsg.conversationId,
            threadId: lastMsg.threadId,
            senderId: lastMsg.senderId,
            senderName: lastMsg.senderName,
            content: lastMsg.content,
            createdAt: lastMsg.createdAt.toISOString(),
          }
        : null,
    });
  }

  return results;
}

async function repairCorruptedDirectDms(workspaceId: string, userId: string) {
  const directConversations = await db
    .select({ conversationId: conversationParticipants.conversationId })
    .from(conversationParticipants)
    .innerJoin(conversations, eq(conversationParticipants.conversationId, conversations.id))
    .where(
      and(
        eq(conversationParticipants.userId, userId),
        eq(conversations.workspaceId, workspaceId),
        eq(conversations.type, "direct"),
      ),
    );

  for (const { conversationId } of directConversations) {
    const participants = await db
      .select({
        userId: conversationParticipants.userId,
        joinedAt: conversationParticipants.joinedAt,
        userType: users.type,
      })
      .from(conversationParticipants)
      .innerJoin(users, eq(conversationParticipants.userId, users.id))
      .where(eq(conversationParticipants.conversationId, conversationId))
      .orderBy(asc(conversationParticipants.joinedAt));

    if (participants.length <= 2) continue;

    const humans = participants.filter((p) => p.userType === "human");
    const botParticipants = participants.filter((p) => p.userType === "bot");
    let keepIds: string[] | null = null;

    if (humans.length === 2) {
      keepIds = humans.map((p) => p.userId);
    } else if (humans.length === 1 && botParticipants.length > 0) {
      const botUserIds = botParticipants.map((p) => p.userId);
      const [oldestBotMessage] = await db
        .select({ senderId: messages.senderId })
        .from(messages)
        .where(and(eq(messages.conversationId, conversationId), inArray(messages.senderId, botUserIds)))
        .orderBy(asc(messages.createdAt))
        .limit(1);
      keepIds = [humans[0].userId, oldestBotMessage?.senderId ?? botParticipants[0].userId];
    }

    if (!keepIds) continue;
    const keep = new Set(keepIds);
    const removeIds = participants.map((p) => p.userId).filter((id) => !keep.has(id));
    if (removeIds.length === 0) continue;

    await db
      .delete(conversationParticipants)
      .where(
        and(
          eq(conversationParticipants.conversationId, conversationId),
          inArray(conversationParticipants.userId, removeIds),
        ),
      );
  }
}

export async function getConversationDetail(conversationId: string, userId: string) {
  const [participant] = await db
    .select({ userId: conversationParticipants.userId })
    .from(conversationParticipants)
    .where(
      and(
        eq(conversationParticipants.conversationId, conversationId),
        eq(conversationParticipants.userId, userId),
      ),
    )
    .limit(1);

  if (!participant) {
    throw new ServiceError("You are not a participant of this conversation", 403);
  }

  const [conv] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);

  if (!conv) {
    throw new ServiceError("Conversation not found", 404);
  }

  const participants = await db
    .select({
      userId: conversationParticipants.userId,
      role: conversationParticipants.role,
      joinedAt: conversationParticipants.joinedAt,
      userName: users.name,
      userEmail: users.email,
      userAvatar: users.avatar,
      userType: users.type,
      botId: bots.id,
      botKind: bots.kind,
    })
    .from(conversationParticipants)
    .innerJoin(users, eq(conversationParticipants.userId, users.id))
    .leftJoin(bots, eq(bots.userId, users.id))
    .where(eq(conversationParticipants.conversationId, conversationId));

  return {
    id: conv.id,
    type: conv.type,
    workspaceId: conv.workspaceId,
    name: conv.name,
    title: conv.title,
    participants: participants.map((p) => ({
      userId: p.userId,
      role: p.role,
      joinedAt: p.joinedAt.toISOString(),
      user: {
        id: p.userId,
        name: p.userName,
        email: p.userEmail,
        avatar: p.userAvatar,
        type: p.userType,
      },
      bot: p.botId ? { id: p.botId, kind: p.botKind! } : null,
    })),
  };
}

export async function listConversationThreads(conversationId: string, userId: string) {
  await requireConversationParticipant(conversationId, userId);

  const rows = await db
    .select()
    .from(conversationThreads)
    .where(eq(conversationThreads.conversationId, conversationId))
    .orderBy(desc(conversationThreads.lastActivityAt));

  return rows.map(toPublicThread);
}

export async function createConversationThread(
  conversationId: string,
  userId: string,
  input: { botId?: string | null; title?: string | null },
) {
  await requireConversationParticipant(conversationId, userId);
  const botId = input.botId ?? (await inferHermesBotId(conversationId));
  await requireHermesBotParticipant(conversationId, botId);

  const title = normalizeThreadTitle(input.title);
  const [thread] = await db
    .insert(conversationThreads)
    .values({
      conversationId,
      botId,
      title,
      createdById: userId,
    })
    .returning();

  return toPublicThread(thread);
}

export async function updateConversationThread(
  conversationId: string,
  threadId: string,
  userId: string,
  input: { title: string },
) {
  await requireConversationParticipant(conversationId, userId);

  const now = new Date();
  const [thread] = await db
    .update(conversationThreads)
    .set({
      title: normalizeThreadTitle(input.title),
      updatedAt: now,
    })
    .where(
      and(
        eq(conversationThreads.id, threadId),
        eq(conversationThreads.conversationId, conversationId),
      ),
    )
    .returning();

  if (!thread) {
    throw new ServiceError("Thread not found", 404);
  }

  return toPublicThread(thread);
}

async function requireConversationParticipant(conversationId: string, userId: string) {
  const [participant] = await db
    .select({ userId: conversationParticipants.userId })
    .from(conversationParticipants)
    .where(
      and(
        eq(conversationParticipants.conversationId, conversationId),
        eq(conversationParticipants.userId, userId),
      ),
    )
    .limit(1);

  if (!participant) {
    throw new ServiceError("You are not a participant of this conversation", 403);
  }
}

async function inferHermesBotId(conversationId: string) {
  const [row] = await db
    .select({ botId: bots.id })
    .from(conversationParticipants)
    .innerJoin(bots, eq(bots.userId, conversationParticipants.userId))
    .where(
      and(
        eq(conversationParticipants.conversationId, conversationId),
        eq(bots.kind, "hermes"),
      ),
    )
    .limit(1);

  if (!row) {
    throw new ServiceError("Conversation does not include a Hermes bot", 400);
  }
  return row.botId;
}

async function requireHermesBotParticipant(conversationId: string, botId: string) {
  const [row] = await db
    .select({ botId: bots.id })
    .from(bots)
    .innerJoin(conversationParticipants, eq(conversationParticipants.userId, bots.userId))
    .where(
      and(
        eq(bots.id, botId),
        eq(bots.kind, "hermes"),
        eq(conversationParticipants.conversationId, conversationId),
      ),
    )
    .limit(1);

  if (!row) {
    throw new ServiceError("Hermes bot is not a participant of this conversation", 400);
  }
}

function normalizeThreadTitle(title: string | null | undefined) {
  const normalized = title?.trim().replace(/\s+/g, " ");
  if (!normalized) return "New task";
  return normalized.slice(0, 255);
}

function toPublicThread(thread: typeof conversationThreads.$inferSelect) {
  return {
    id: thread.id,
    conversationId: thread.conversationId,
    botId: thread.botId,
    title: thread.title,
    status: thread.status,
    createdById: thread.createdById,
    lastActivityAt: thread.lastActivityAt.toISOString(),
    createdAt: thread.createdAt.toISOString(),
    updatedAt: thread.updatedAt.toISOString(),
  };
}

export async function createChannel(
  workspaceId: string,
  name: string,
  userId: string
) {
  // Check user is workspace member
  const [membership] = await db
    .select()
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, userId)
      )
    )
    .limit(1);

  if (!membership) {
    throw new ServiceError("You are not a member of this workspace", 403);
  }

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
}
