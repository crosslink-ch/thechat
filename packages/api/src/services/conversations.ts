import { and, asc, desc, eq, gt, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import type { WsServerEvent } from "@thechat/shared";
import { db } from "../db";
import {
  attachments,
  botInvocations,
  bots,
  conversations,
  conversationParticipants,
  conversationThreads,
  eventOutbox,
  messages,
  users,
  workspaceMembers,
  workspaces,
} from "../db/schema";
import { attachmentsByMessageIds } from "../attachments/public";
import { log } from "../logging";
import { publishWsEventToUsers } from "../realtime";
import { currentHermesDispatchTimeoutCutoff } from "./bot-runtime";
import { requireConversationMutationAccess } from "./conversation-mutation-access";
import { ServiceError } from "./errors";
import { canUserAccessAttachments } from "./messages";

const channelLog = log.child({ component: "channels" });

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
  const includeAttachments = await canUserAccessAttachments(db, userId);
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

    const lastMessageAttachments = includeAttachments && lastMsg
      ? (await attachmentsByMessageIds([lastMsg.id])).get(lastMsg.id) ?? []
      : [];
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
            attachments: lastMessageAttachments,
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
    .select({
      userId: conversationParticipants.userId,
      conversationType: conversations.type,
      workspaceMemberUserId: workspaceMembers.userId,
    })
    .from(conversationParticipants)
    .innerJoin(
      conversations,
      eq(conversationParticipants.conversationId, conversations.id),
    )
    .leftJoin(
      workspaceMembers,
      and(
        eq(workspaceMembers.workspaceId, conversations.workspaceId),
        eq(workspaceMembers.userId, userId),
      ),
    )
    .where(
      and(
        eq(conversationParticipants.conversationId, conversationId),
        eq(conversationParticipants.userId, userId),
      ),
    )
    .limit(1);

  if (
    !participant ||
    (participant.conversationType === "group" && !participant.workspaceMemberUserId)
  ) {
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
      botCommands: bots.commandsJson,
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
      bot: p.botId
        ? { id: p.botId, kind: p.botKind!, commands: p.botCommands ?? null }
        : null,
    })),
  };
}

const DEFAULT_THREAD_PAGE_SIZE = 50;
const MAX_THREAD_PAGE_SIZE = 100;

type ConversationThreadCursor = {
  lastActivityAt: Date;
  id: string;
};

export async function listConversationThreads(
  conversationId: string,
  userId: string,
  options: {
    limit?: number | null;
    cursor?: string | null;
    botId?: string | null;
    status?: string | null;
  } = {},
) {
  await requireConversationParticipant(conversationId, userId);

  const limit = normalizeThreadPageSize(options.limit);
  const cursor = parseConversationThreadCursor(options.cursor);
  const conditions = [eq(conversationThreads.conversationId, conversationId)];
  if (options.botId) {
    await requireBotParticipant(conversationId, options.botId);
    conditions.push(eq(conversationThreads.botId, options.botId));
  }
  if (options.status) {
    conditions.push(eq(conversationThreads.status, options.status));
  }
  if (cursor) {
    const cursorCondition = or(
      lt(conversationThreads.lastActivityAt, cursor.lastActivityAt),
      and(
        eq(conversationThreads.lastActivityAt, cursor.lastActivityAt),
        lt(conversationThreads.id, cursor.id),
      ),
    );
    if (cursorCondition) conditions.push(cursorCondition);
  }

  const rows = await db
    .select()
    .from(conversationThreads)
    .where(and(...conditions))
    .orderBy(desc(conversationThreads.lastActivityAt), desc(conversationThreads.id))
    .limit(limit + 1);

  const pageRows = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  return {
    items: pageRows.map(toPublicThread),
    nextCursor: hasMore
      ? encodeConversationThreadCursor(pageRows.at(-1) ?? null)
      : null,
    hasMore,
  };
}

export async function createConversationThread(
  conversationId: string,
  userId: string,
  input: { botId?: string | null; title?: string | null; branchFromThreadId?: string | null },
  options: { afterWorkspaceLocked?: () => Promise<void> } = {},
) {
  return db.transaction(async (tx) => {
    await requireConversationMutationAccess(tx, conversationId, userId, options);
    const botId = input.botId ?? (await inferHermesBotId(tx, conversationId));
    await requireHermesBotParticipant(tx, conversationId, botId);

    const title = normalizeThreadTitle(input.title);
    const branchPending = input.branchFromThreadId !== undefined;
    const branchFromThreadId = input.branchFromThreadId ?? null;
    if (branchFromThreadId) {
      await requireConversationThread(tx, conversationId, branchFromThreadId, botId);
    }
    const [thread] = await tx
      .insert(conversationThreads)
      .values({
        conversationId,
        botId,
        title,
        branchPending,
        branchFromThreadId,
        createdById: userId,
      })
      .returning();

    return toPublicThread(thread);
  });
}

export async function updateConversationThread(
  conversationId: string,
  threadId: string,
  userId: string,
  input: { title: string },
  options: { afterWorkspaceLocked?: () => Promise<void> } = {},
) {
  return db.transaction(async (tx) => {
    await requireConversationMutationAccess(tx, conversationId, userId, options);

    const now = new Date();
    const [thread] = await tx
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
  });
}

export async function requireConversationParticipant(conversationId: string, userId: string) {
  const [participant] = await db
    .select({
      userId: conversationParticipants.userId,
      conversationType: conversations.type,
      workspaceMemberUserId: workspaceMembers.userId,
    })
    .from(conversationParticipants)
    .innerJoin(
      conversations,
      eq(conversationParticipants.conversationId, conversations.id),
    )
    .leftJoin(
      workspaceMembers,
      and(
        eq(workspaceMembers.workspaceId, conversations.workspaceId),
        eq(workspaceMembers.userId, userId),
      ),
    )
    .where(
      and(
        eq(conversationParticipants.conversationId, conversationId),
        eq(conversationParticipants.userId, userId),
      ),
    )
    .limit(1);

  if (
    !participant ||
    (participant.conversationType === "group" && !participant.workspaceMemberUserId)
  ) {
    throw new ServiceError("You are not a participant of this conversation", 403);
  }
}

async function requireConversationThread(
  executor: typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0],
  conversationId: string,
  threadId: string,
  botId: string,
) {
  const [thread] = await executor
    .select({ id: conversationThreads.id })
    .from(conversationThreads)
    .where(
      and(
        eq(conversationThreads.id, threadId),
        eq(conversationThreads.conversationId, conversationId),
        eq(conversationThreads.botId, botId),
      ),
    )
    .limit(1);
  if (!thread) {
    throw new ServiceError("Branch source thread not found for this bot", 404);
  }
}

async function inferHermesBotId(
  executor: typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0],
  conversationId: string,
) {
  const [row] = await executor
    .select({ botId: bots.id })
    .from(conversationParticipants)
    .innerJoin(bots, eq(bots.userId, conversationParticipants.userId))
    .where(
      and(
        eq(conversationParticipants.conversationId, conversationId),
        inArray(bots.kind, ["hermes", "hermes-rpc"]),
      ),
    )
    .limit(1);

  if (!row) {
    throw new ServiceError("Conversation does not include a Hermes bot", 400);
  }
  return row.botId;
}

async function requireHermesBotParticipant(
  executor: typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0],
  conversationId: string,
  botId: string,
) {
  const [row] = await executor
    .select({ botId: bots.id })
    .from(bots)
    .innerJoin(conversationParticipants, eq(conversationParticipants.userId, bots.userId))
    .where(
      and(
        eq(bots.id, botId),
        inArray(bots.kind, ["hermes", "hermes-rpc"]),
        eq(conversationParticipants.conversationId, conversationId),
      ),
    )
    .limit(1);

  if (!row) {
    throw new ServiceError("Hermes bot is not a participant of this conversation", 400);
  }
}

async function requireBotParticipant(conversationId: string, botId: string) {
  const [row] = await db
    .select({ botId: bots.id })
    .from(bots)
    .innerJoin(conversationParticipants, eq(conversationParticipants.userId, bots.userId))
    .where(
      and(
        eq(bots.id, botId),
        eq(conversationParticipants.conversationId, conversationId),
      ),
    )
    .limit(1);

  if (!row) {
    throw new ServiceError("Bot is not a participant of this conversation", 400);
  }
}

function normalizeThreadTitle(title: string | null | undefined) {
  const normalized = title?.trim().replace(/\s+/g, " ");
  if (!normalized) return "New task";
  return normalized.slice(0, 255);
}

function normalizeThreadPageSize(limit: number | null | undefined) {
  if (!Number.isFinite(limit ?? NaN)) return DEFAULT_THREAD_PAGE_SIZE;
  return Math.max(1, Math.min(Math.trunc(limit!), MAX_THREAD_PAGE_SIZE));
}

function encodeConversationThreadCursor(
  thread: typeof conversationThreads.$inferSelect | null,
) {
  if (!thread) return null;
  const payload = JSON.stringify({
    lastActivityAt: thread.lastActivityAt.toISOString(),
    id: thread.id,
  });
  return Buffer.from(payload).toString("base64url");
}

function parseConversationThreadCursor(
  cursor: string | null | undefined,
): ConversationThreadCursor | null {
  if (!cursor) return null;

  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    const lastActivityAt = new Date(parsed.lastActivityAt);
    if (
      !parsed ||
      typeof parsed.id !== "string" ||
      Number.isNaN(lastActivityAt.getTime())
    ) {
      throw new Error("Invalid cursor payload");
    }
    return { id: parsed.id, lastActivityAt };
  } catch {
    throw new ServiceError("Invalid thread pagination cursor", 400);
  }
}

function toPublicThread(thread: typeof conversationThreads.$inferSelect) {
  return {
    id: thread.id,
    conversationId: thread.conversationId,
    botId: thread.botId,
    title: thread.title,
    status: thread.status,
    branchPending: thread.branchPending,
    branchFromThreadId: thread.branchFromThreadId,
    createdById: thread.createdById,
    lastActivityAt: thread.lastActivityAt.toISOString(),
    createdAt: thread.createdAt.toISOString(),
    updatedAt: thread.updatedAt.toISOString(),
  };
}

export async function createChannel(
  workspaceId: string,
  name: string,
  userId: string,
  options: { afterWorkspaceLocked?: () => Promise<void> } = {},
) {
  const normalized = normalizeChannelName(name);

  try {
    const result = await db.transaction(async (tx) => {
      const [workspace] = await tx
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId))
        .for("update")
        .limit(1);
      if (!workspace) {
        throw new ServiceError("Workspace not found", 404);
      }

      await options.afterWorkspaceLocked?.();

      const [membership] = await tx
        .select({ role: workspaceMembers.role })
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, workspaceId),
            eq(workspaceMembers.userId, userId),
          ),
        )
        .limit(1);

      if (!membership) {
        throw new ServiceError("You are not a member of this workspace", 403);
      }

      const [existing] = await tx
        .select({ id: conversations.id })
        .from(conversations)
        .where(
          and(
            eq(conversations.workspaceId, workspaceId),
            eq(conversations.name, normalized.slug),
          ),
        )
        .limit(1);
      if (existing) {
        throw new ServiceError("A channel with this name already exists", 409);
      }

      const [channel] = await tx
        .insert(conversations)
        .values({
          title: normalized.title,
          type: "group",
          workspaceId,
          name: normalized.slug,
        })
        .returning();

      const allMembers = await tx
        .select({
          userId: workspaceMembers.userId,
          role: workspaceMembers.role,
        })
        .from(workspaceMembers)
        .where(eq(workspaceMembers.workspaceId, workspaceId));

      if (allMembers.length > 0) {
        await tx.insert(conversationParticipants).values(
          allMembers.map((member) => ({
            conversationId: channel.id,
            userId: member.userId,
            role: member.role,
          })),
        );
      }

      return {
        channel: toWorkspaceChannel(channel),
        targetUserIds: allMembers.map((member) => member.userId),
      };
    });

    await publishChannelLifecycleEvent(result.targetUserIds, {
      type: "channel_created",
      workspaceId,
      channel: result.channel,
    });
    return result.channel;
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ServiceError("A channel with this name already exists", 409);
    }
    throw error;
  }
}

export async function renameChannel(
  conversationId: string,
  name: string,
  userId: string,
  options: { afterWorkspaceLocked?: () => Promise<void> } = {},
) {
  const normalized = normalizeChannelName(name);

  try {
    const result = await db.transaction(async (tx) => {
      const [candidate] = await tx
        .select({ workspaceId: conversations.workspaceId })
        .from(conversations)
        .where(
          and(
            eq(conversations.id, conversationId),
            eq(conversations.type, "group"),
          ),
        )
        .limit(1);
      if (!candidate?.workspaceId) {
        throw new ServiceError("Channel not found", 404);
      }

      const [workspace] = await tx
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(eq(workspaces.id, candidate.workspaceId))
        .for("update")
        .limit(1);
      if (!workspace) {
        throw new ServiceError("Channel not found", 404);
      }

      await options.afterWorkspaceLocked?.();

      const [channel] = await tx
        .select()
        .from(conversations)
        .where(
          and(
            eq(conversations.id, conversationId),
            eq(conversations.type, "group"),
            eq(conversations.workspaceId, workspace.id),
          ),
        )
        .for("update")
        .limit(1);
      if (!channel?.workspaceId) {
        throw new ServiceError("Channel not found", 404);
      }

      await requireChannelManager(tx, workspace.id, userId);

      const [existing] = await tx
        .select({ id: conversations.id })
        .from(conversations)
        .where(
          and(
            eq(conversations.workspaceId, workspace.id),
            eq(conversations.name, normalized.slug),
          ),
        )
        .limit(1);
      if (existing && existing.id !== channel.id) {
        throw new ServiceError("A channel with this name already exists", 409);
      }

      const [updated] = await tx
        .update(conversations)
        .set({ name: normalized.slug, title: normalized.title })
        .where(eq(conversations.id, channel.id))
        .returning();
      const targetUsers = await tx
        .select({ userId: workspaceMembers.userId })
        .from(workspaceMembers)
        .where(eq(workspaceMembers.workspaceId, workspace.id));

      return {
        channel: toWorkspaceChannel(updated),
        targetUserIds: targetUsers.map((member) => member.userId),
        workspaceId: workspace.id,
      };
    });

    await publishChannelLifecycleEvent(result.targetUserIds, {
      type: "channel_renamed",
      workspaceId: result.workspaceId,
      channel: result.channel,
    });
    return result.channel;
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ServiceError("A channel with this name already exists", 409);
    }
    throw error;
  }
}

export async function deleteChannel(
  conversationId: string,
  userId: string,
  options: { afterWorkspaceLocked?: () => Promise<void> } = {},
) {
  const hermesDispatchCutoff = currentHermesDispatchTimeoutCutoff();

  const result = await db.transaction(async (tx) => {
    const [candidate] = await tx
      .select({ workspaceId: conversations.workspaceId })
      .from(conversations)
      .where(
        and(
          eq(conversations.id, conversationId),
          eq(conversations.type, "group"),
        ),
      )
      .limit(1);
    if (!candidate?.workspaceId) {
      throw new ServiceError("Channel not found", 404);
    }

    const [workspace] = await tx
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.id, candidate.workspaceId))
      .for("update")
      .limit(1);
    if (!workspace) {
      throw new ServiceError("Channel not found", 404);
    }

    await options.afterWorkspaceLocked?.();

    // This row lock also blocks new messages and attachment reservations from
    // acquiring their foreign-key key-share lock while deletion is decided.
    const [channel] = await tx
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.id, conversationId),
          eq(conversations.type, "group"),
          eq(conversations.workspaceId, workspace.id),
        ),
      )
      .for("update")
      .limit(1);

    if (!channel?.workspaceId) {
      throw new ServiceError("Channel not found", 404);
    }

    await requireChannelManager(tx, workspace.id, userId);

    const [activeInvocation] = await tx
      .select({ id: botInvocations.id })
      .from(botInvocations)
      .where(
        and(
          eq(botInvocations.conversationId, channel.id),
          or(
            and(
              eq(botInvocations.status, "queued"),
              or(
                ne(botInvocations.adapterKind, "hermes"),
                gt(botInvocations.createdAt, hermesDispatchCutoff),
              ),
            ),
            eq(botInvocations.status, "running"),
            and(
              eq(botInvocations.status, "claimed"),
              sql`NULLIF(${botInvocations.responseJson}->'completion'->>'type', '') IS NULL`,
              sql`COALESCE(${botInvocations.responseJson}->>'silent', 'false') <> 'true'`,
            ),
          ),
        ),
      )
      .limit(1);

    const [pendingTargetedEvent] = await tx
      .select({ id: eventOutbox.id })
      .from(eventOutbox)
      .where(
        and(
          eq(eventOutbox.eventType, "chat.message.sent"),
          eq(eventOutbox.partitionKey, channel.id),
          isNull(eventOutbox.publishedAt),
          isNull(eventOutbox.deadAt),
          sql`jsonb_typeof(${eventOutbox.event}->'payload'->'targetBotIds') = 'array'`,
          sql`jsonb_array_length(${eventOutbox.event}->'payload'->'targetBotIds') > 0`,
        ),
      )
      .limit(1);

    if (activeInvocation || pendingTargetedEvent) {
      throw new ServiceError(
        "Wait for active bot runs to finish before deleting this channel",
        409,
      );
    }

    // Attachment rows own private object-store coordinates. Cascading them
    // away would make their exact S3 versions impossible to clean up safely.
    const [attachment] = await tx
      .select({ id: attachments.id })
      .from(attachments)
      .where(eq(attachments.conversationId, channel.id))
      .limit(1);
    if (attachment) {
      throw new ServiceError(
        "Channels with attachments cannot be deleted",
        409,
      );
    }

    const targetUsers = await tx
      .select({ userId: workspaceMembers.userId })
      .from(workspaceMembers)
      .where(eq(workspaceMembers.workspaceId, workspace.id));
    await tx.delete(conversations).where(eq(conversations.id, channel.id));
    return {
      ok: true as const,
      deletedChannelId: channel.id,
      workspaceId: workspace.id,
      targetUserIds: targetUsers.map((member) => member.userId),
    };
  });

  await publishChannelLifecycleEvent(result.targetUserIds, {
    type: "channel_deleted",
    workspaceId: result.workspaceId,
    channelId: result.deletedChannelId,
  });
  return { ok: result.ok, deletedChannelId: result.deletedChannelId };
}

type ChannelLifecycleEvent = Extract<
  WsServerEvent,
  { type: "channel_created" | "channel_renamed" | "channel_deleted" }
>;

async function publishChannelLifecycleEvent(
  targetUserIds: string[],
  event: ChannelLifecycleEvent,
) {
  try {
    await publishWsEventToUsers(targetUserIds, event);
  } catch (error) {
    // The channel mutation has already committed. Realtime fanout failure must
    // not turn a successful REST mutation into an ambiguous client failure.
    channelLog.warn(
      {
        err: error,
        eventType: event.type,
        workspaceId: event.workspaceId,
      },
      "channel.realtime_publish_failed",
    );
  }
}

function normalizeChannelName(name: string) {
  const title = name.trim().replace(/\s+/g, " ");
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 100);

  if (!slug) {
    throw new ServiceError(
      "Channel name must include at least one letter or number",
      400,
    );
  }
  return { title, slug };
}

function toWorkspaceChannel(channel: typeof conversations.$inferSelect) {
  if (!channel.workspaceId || !channel.name) {
    throw new ServiceError("Channel data is incomplete", 500);
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

async function requireChannelManager(
  executor: Pick<typeof db, "select">,
  workspaceId: string,
  userId: string,
) {
  const [membership] = await executor
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, userId),
      ),
    )
    .limit(1);

  if (!membership) {
    throw new ServiceError("You are not a member of this workspace", 403);
  }
  if (membership.role !== "owner" && membership.role !== "admin") {
    throw new ServiceError(
      "Only workspace owners and admins can manage channels",
      403,
    );
  }
}

function isUniqueViolation(error: unknown) {
  let current = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    if (
      typeof current === "object" &&
      "code" in current &&
      (current as { code?: unknown }).code === "23505"
    ) {
      return true;
    }
    current =
      typeof current === "object" && "cause" in current
        ? (current as { cause?: unknown }).cause
        : null;
  }
  return false;
}
