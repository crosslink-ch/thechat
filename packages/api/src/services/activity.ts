import type { ActivityItem, ActivitySnapshot } from "@thechat/shared";
import {
  and,
  desc,
  eq,
  inArray,
  ne,
} from "drizzle-orm";
import { db } from "../db";
import {
  conversationParticipants,
  conversationThreads,
  conversations,
  messages,
  messageUnreads,
  users,
  workspaceMembers,
  workspaces,
} from "../db/schema";
import { ServiceError } from "./errors";

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Stage durable unread rows in the same transaction as a newly created message.
 * Only human recipients get rows; bots do not have an Activity inbox.
 */
export async function recordMessageUnreads(
  tx: DbTransaction,
  message: { id: string; conversationId: string; senderId: string },
) {
  const recipients = await tx
    .select({ userId: conversationParticipants.userId })
    .from(conversationParticipants)
    .innerJoin(
      conversations,
      eq(conversations.id, conversationParticipants.conversationId),
    )
    .innerJoin(
      workspaceMembers,
      and(
        eq(workspaceMembers.workspaceId, conversations.workspaceId),
        eq(workspaceMembers.userId, conversationParticipants.userId),
      ),
    )
    .innerJoin(users, eq(users.id, conversationParticipants.userId))
    .where(
      and(
        eq(conversationParticipants.conversationId, message.conversationId),
        ne(conversationParticipants.userId, message.senderId),
        eq(users.type, "human"),
      ),
    );

  if (recipients.length === 0) return;
  await tx
    .insert(messageUnreads)
    .values(
      recipients.map(({ userId }) => ({
        messageId: message.id,
        conversationId: message.conversationId,
        userId,
      })),
    )
    .onConflictDoNothing();
}

export async function listActivity(userId: string): Promise<ActivitySnapshot> {
  const rows = await db
    .select({
      conversationId: messageUnreads.conversationId,
      conversationType: conversations.type,
      conversationName: conversations.name,
      conversationTitle: conversations.title,
      workspaceId: workspaces.id,
      workspaceName: workspaces.name,
      messageId: messages.id,
      threadId: messages.threadId,
      threadTitle: conversationThreads.title,
      senderId: messages.senderId,
      senderName: users.name,
      senderType: users.type,
      content: messages.content,
      createdAt: messages.createdAt,
    })
    .from(messageUnreads)
    .innerJoin(messages, eq(messages.id, messageUnreads.messageId))
    .innerJoin(
      conversations,
      eq(conversations.id, messageUnreads.conversationId),
    )
    .innerJoin(
      workspaceMembers,
      and(
        eq(workspaceMembers.workspaceId, conversations.workspaceId),
        eq(workspaceMembers.userId, messageUnreads.userId),
      ),
    )
    .innerJoin(workspaces, eq(workspaces.id, conversations.workspaceId))
    .innerJoin(users, eq(users.id, messages.senderId))
    .leftJoin(conversationThreads, eq(conversationThreads.id, messages.threadId))
    .where(eq(messageUnreads.userId, userId))
    .orderBy(desc(messages.createdAt), desc(messages.id));

  const grouped = new Map<string, ActivityItem>();
  for (const row of rows) {
    const existing = grouped.get(row.conversationId);
    if (existing) {
      existing.unreadCount += 1;
      continue;
    }

    grouped.set(row.conversationId, {
      conversationId: row.conversationId,
      conversationType: row.conversationType,
      conversationName:
        row.conversationType === "direct"
          ? row.senderName
          : (row.conversationTitle ?? row.conversationName ?? "Channel"),
      workspaceId: row.workspaceId,
      workspaceName: row.workspaceName,
      unreadCount: 1,
      latestMessage: {
        id: row.messageId,
        threadId: row.threadId,
        threadTitle: row.threadTitle,
        senderId: row.senderId,
        senderName: row.senderName,
        senderType: row.senderType,
        content: row.content,
        createdAt: row.createdAt.toISOString(),
      },
    });
  }

  return {
    items: [...grouped.values()],
    totalUnreadMessages: rows.length,
  };
}

async function requireActivityConversationAccess(
  conversationId: string,
  userId: string,
) {
  const [access] = await db
    .select({
      participantUserId: conversationParticipants.userId,
      workspaceId: conversations.workspaceId,
      workspaceMemberUserId: workspaceMembers.userId,
    })
    .from(conversationParticipants)
    .innerJoin(
      conversations,
      eq(conversations.id, conversationParticipants.conversationId),
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
  if (!access || (access.workspaceId && !access.workspaceMemberUserId)) {
    throw new ServiceError("You are not a participant of this conversation", 403);
  }
}

export type ConversationReadSelection =
  | { messageIds: string[] }
  | { all: true };

export async function markConversationRead(
  conversationId: string,
  userId: string,
  selection: ConversationReadSelection,
): Promise<ActivitySnapshot> {
  await requireActivityConversationAccess(conversationId, userId);

  if ("all" in selection) {
    await db
      .delete(messageUnreads)
      .where(
        and(
          eq(messageUnreads.userId, userId),
          eq(messageUnreads.conversationId, conversationId),
        ),
      );
    return listActivity(userId);
  }

  const requestedIds = [...new Set(selection.messageIds)];
  const renderedMessages = await db
    .select({ id: messages.id, conversationId: messages.conversationId })
    .from(messages)
    .where(inArray(messages.id, requestedIds));
  if (
    renderedMessages.length !== requestedIds.length ||
    renderedMessages.some((message) => message.conversationId !== conversationId)
  ) {
    throw new ServiceError(
      "Rendered message does not belong to this conversation",
      400,
    );
  }

  // Delete only IDs the client actually rendered. A timestamp/read-cursor range
  // can consume an earlier transaction that committed after the page snapshot
  // but before this request, losing an unread message the user never saw.
  await db
    .delete(messageUnreads)
    .where(
      and(
        eq(messageUnreads.userId, userId),
        eq(messageUnreads.conversationId, conversationId),
        inArray(messageUnreads.messageId, requestedIds),
      ),
    );

  return listActivity(userId);
}

export async function markAllActivityRead(
  userId: string,
): Promise<ActivitySnapshot> {
  await db.delete(messageUnreads).where(eq(messageUnreads.userId, userId));
  return listActivity(userId);
}
