import type {
  ActivityItem,
  ActivitySnapshot,
  ActivityThreadItem,
} from "@thechat/shared";
import {
  and,
  desc,
  eq,
  inArray,
  ne,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { isNull, or } from "drizzle-orm";
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

const rootMessages = alias(messages, "root_messages");
const rootSenders = alias(users, "root_senders");

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
      parentMessageId: messages.parentMessageId,
      alsoSentToConversation: messages.alsoSentToConversation,
      rootSenderId: rootMessages.senderId,
      rootSenderName: rootSenders.name,
      rootContent: rootMessages.content,
      rootCreatedAt: rootMessages.createdAt,
    })
    .from(messageUnreads)
    .innerJoin(messages, eq(messages.id, messageUnreads.messageId))
    .leftJoin(rootMessages, eq(rootMessages.id, messages.parentMessageId))
    .leftJoin(rootSenders, eq(rootSenders.id, rootMessages.senderId))
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

  const grouped = new Map<string, ActivityItem & { unreadThreadIds: (string | null)[] }>();
  const unreadScopes = new Map<string, Set<string | null>>();
  const threads = new Map<string, ActivityThreadItem>();
  const directNames = await directConversationNames(
    userId,
    [...new Set(rows.filter((row) => row.conversationType === "direct").map((row) => row.conversationId))],
  );
  for (const row of rows) {
    // A reply that stayed in its thread is a thread item, not a channel unread.
    if (row.parentMessageId && !row.alsoSentToConversation) {
      const thread = threads.get(row.parentMessageId);
      if (thread) {
        thread.unreadCount += 1;
        continue;
      }
      threads.set(row.parentMessageId, {
        conversationId: row.conversationId,
        conversationType: row.conversationType,
        conversationName:
          row.conversationType === "direct"
            ? (directNames.get(row.conversationId) ?? row.senderName)
            : (row.conversationTitle ?? row.conversationName ?? "Channel"),
        workspaceId: row.workspaceId,
        workspaceName: row.workspaceName,
        rootMessageId: row.parentMessageId,
        root: {
          senderId: row.rootSenderId ?? row.senderId,
          senderName: row.rootSenderName ?? row.senderName,
          content: row.rootContent ?? "",
          createdAt: (row.rootCreatedAt ?? row.createdAt).toISOString(),
        },
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
      continue;
    }
    const existing = grouped.get(row.conversationId);
    if (existing) {
      existing.unreadCount += 1;
      const scopes = unreadScopes.get(row.conversationId)!;
      if (!scopes.has(row.threadId)) {
        scopes.add(row.threadId);
        existing.unreadThreadIds.push(row.threadId);
      }
      continue;
    }

    unreadScopes.set(row.conversationId, new Set([row.threadId]));
    grouped.set(row.conversationId, {
      conversationId: row.conversationId,
      conversationType: row.conversationType,
      conversationName:
        row.conversationType === "direct"
          ? (directNames.get(row.conversationId) ?? row.senderName)
          : (row.conversationTitle ?? row.conversationName ?? "Channel"),
      workspaceId: row.workspaceId,
      workspaceName: row.workspaceName,
      unreadCount: 1,
      unreadThreadIds: [row.threadId],
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
    threads: [...threads.values()],
    totalUnreadMessages: rows.length,
  };
}

/** The other person's name for each direct conversation. */
async function directConversationNames(userId: string, conversationIds: string[]) {
  if (conversationIds.length === 0) return new Map<string, string>();
  const rows = await db
    .select({ conversationId: conversationParticipants.conversationId, name: users.name })
    .from(conversationParticipants)
    .innerJoin(users, eq(users.id, conversationParticipants.userId))
    .where(
      and(
        inArray(conversationParticipants.conversationId, conversationIds),
        ne(conversationParticipants.userId, userId),
      ),
    );
  return new Map(rows.map((row) => [row.conversationId, row.name]));
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
  | { messageIds: string[]; threadId?: string | null }
  /** Everything in the main timeline, or every reply of one thread. */
  | { all: true; rootMessageId?: string };

export async function markConversationRead(
  conversationId: string,
  userId: string,
  selection: ConversationReadSelection,
): Promise<ActivitySnapshot> {
  await requireActivityConversationAccess(conversationId, userId);

  if ("all" in selection) {
    // Followed threads keep their own unread state, like Slack: marking a
    // channel read does not mark its threads read, and vice versa.
    const scope = selection.rootMessageId
      ? eq(messages.parentMessageId, selection.rootMessageId)
      : or(isNull(messages.parentMessageId), eq(messages.alsoSentToConversation, true));
    await db
      .delete(messageUnreads)
      .where(
        and(
          eq(messageUnreads.userId, userId),
          eq(messageUnreads.conversationId, conversationId),
          inArray(
            messageUnreads.messageId,
            db
              .select({ id: messages.id })
              .from(messages)
              .where(and(eq(messages.conversationId, conversationId), scope)),
          ),
        ),
      );
    return listActivity(userId);
  }

  const requestedIds = [...new Set(selection.messageIds)];
  const renderedMessages = await db
    .select({ id: messages.id, conversationId: messages.conversationId, threadId: messages.threadId })
    .from(messages)
    .where(inArray(messages.id, requestedIds));
  if (
    renderedMessages.some((message) => message.conversationId !== conversationId)
  ) {
    throw new ServiceError(
      "Rendered message does not belong to this conversation",
      400,
    );
  }

  if (selection.threadId !== undefined && renderedMessages.some(
    (message) => message.threadId !== selection.threadId,
  )) {
    throw new ServiceError("Message does not belong to this task", 400);
  }

  // Deleted IDs are harmless (their unread rows cascade away). Only acknowledge
  // exact captured backlog/rendered IDs, never a timestamp/read-cursor range:
  // a range can consume an earlier transaction that committed after the snapshot
  // but before this request, losing an unread message the user never saw.
  if (renderedMessages.length === 0) return listActivity(userId);
  await db
    .delete(messageUnreads)
    .where(
      and(
        eq(messageUnreads.userId, userId),
        eq(messageUnreads.conversationId, conversationId),
        inArray(messageUnreads.messageId, renderedMessages.map((message) => message.id)),
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
