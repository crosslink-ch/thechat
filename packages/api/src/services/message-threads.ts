import { and, desc, eq, gt, inArray, isNull, ne, or, sql } from "drizzle-orm";
import type { MessageThreadSummary } from "@thechat/shared";
import { db } from "../db";
import {
  conversationParticipants,
  conversations,
  messageThreadFollowers,
  messageUnreads,
  messages,
  users,
  workspaceMembers,
} from "../db/schema";
import { ServiceError } from "./errors";
import { storedReferenceIds } from "./message-parts";

/**
 * Reply threads (Slack-style). A reply points at its root message through
 * `messages.parent_message_id`; threads are one level deep. Replies stay out
 * of the conversation's main timeline unless they were also sent there.
 *
 * Not to be confused with `messages.thread_id`, which scopes a Hermes task.
 */

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = typeof db | DbTransaction;

const THREAD_SUMMARY_PARTICIPANTS = 5;

/** Messages that belong to a conversation's main timeline. */
export function mainTimelineCondition() {
  return or(
    isNull(messages.parentMessageId),
    eq(messages.alsoSentToConversation, true),
  )!;
}

export interface ReplyRoot {
  id: string;
  conversationId: string;
  threadId: string | null;
  senderId: string;
}

/**
 * The root a new reply attaches to. Replying to a reply continues that
 * reply's thread, so threads never nest.
 */
export async function resolveReplyRoot(
  executor: Executor,
  conversationId: string,
  parentMessageId: string,
): Promise<ReplyRoot> {
  const select = (id: string) =>
    executor
      .select({
        id: messages.id,
        conversationId: messages.conversationId,
        threadId: messages.threadId,
        senderId: messages.senderId,
        parentMessageId: messages.parentMessageId,
      })
      .from(messages)
      .where(eq(messages.id, id))
      .limit(1)
      .then((rows) => rows[0] ?? null);

  let root = await select(parentMessageId);
  if (root?.parentMessageId) root = await select(root.parentMessageId);
  if (!root || root.conversationId !== conversationId) {
    throw new ServiceError(
      "The message you are replying to does not belong to this conversation",
      400,
    );
  }
  return {
    id: root.id,
    conversationId: root.conversationId,
    threadId: root.threadId,
    senderId: root.senderId,
  };
}

/**
 * Keep the root's reply counters and the thread's followers current for a
 * newly inserted reply. Call it in the reply's transaction, before unread
 * rows are recorded (an @mention makes someone a follower first).
 *
 * Following rules, like Slack:
 * - the root's author follows once someone replies,
 * - in a direct conversation both people follow,
 * - replying or being @mentioned (re)follows, even after an unfollow,
 * - otherwise an explicit unfollow is kept.
 *
 * A "parts-v1" reply mentions exactly the users it references by ID; a
 * legacy text reply is matched by name.
 */
export async function recordThreadReply(
  tx: DbTransaction,
  reply: {
    id: string;
    conversationId: string;
    senderId: string;
    content: string;
    contentFormat?: string | null;
    parts?: unknown;
    createdAt: Date;
    parentMessageId: string | null;
  },
) {
  if (!reply.parentMessageId) return;
  const replyAt = reply.createdAt.toISOString();
  const [root] = await tx
    .update(messages)
    .set({
      replyCount: sql`${messages.replyCount} + 1`,
      lastReplyAt: sql`GREATEST(COALESCE(${messages.lastReplyAt}, ${replyAt}::timestamptz), ${replyAt}::timestamptz)`,
    })
    .where(eq(messages.id, reply.parentMessageId))
    .returning({ senderId: messages.senderId });
  if (!root) return;

  const members = await tx
    .select({
      userId: conversationParticipants.userId,
      name: users.name,
      conversationType: conversations.type,
    })
    .from(conversationParticipants)
    .innerJoin(users, eq(users.id, conversationParticipants.userId))
    .innerJoin(
      conversations,
      eq(conversations.id, conversationParticipants.conversationId),
    )
    .where(
      and(
        eq(conversationParticipants.conversationId, reply.conversationId),
        eq(users.type, "human"),
      ),
    );
  if (members.length === 0) return;
  const humanIds = new Set(members.map((member) => member.userId));
  const direct = members[0]!.conversationType === "direct";

  const keepExisting = new Set<string>();
  const refollow = new Set<string>();
  if (humanIds.has(root.senderId)) keepExisting.add(root.senderId);
  if (direct) for (const id of humanIds) keepExisting.add(id);
  if (humanIds.has(reply.senderId)) refollow.add(reply.senderId);
  for (const member of members) {
    if (member.userId !== reply.senderId && messageMentionsUser(reply, member)) {
      refollow.add(member.userId);
    }
  }
  for (const id of refollow) keepExisting.delete(id);

  const row = (userId: string) => ({
    rootMessageId: reply.parentMessageId!,
    conversationId: reply.conversationId,
    userId,
    following: true,
  });
  if (keepExisting.size > 0) {
    await tx
      .insert(messageThreadFollowers)
      .values([...keepExisting].map(row))
      .onConflictDoNothing();
  }
  if (refollow.size > 0) {
    await tx
      .insert(messageThreadFollowers)
      .values([...refollow].map(row))
      .onConflictDoUpdate({
        target: [messageThreadFollowers.rootMessageId, messageThreadFollowers.userId],
        set: { following: true, updatedAt: new Date() },
      });
  }
}

/**
 * Unread rows for a reply that is only in its thread: followers get them,
 * nobody else (their channel does not become unread).
 */
export async function recordThreadReplyUnreads(
  tx: DbTransaction,
  reply: { id: string; conversationId: string; senderId: string; parentMessageId: string },
) {
  const recipients = await tx
    .select({ userId: messageThreadFollowers.userId })
    .from(messageThreadFollowers)
    .innerJoin(users, eq(users.id, messageThreadFollowers.userId))
    .innerJoin(
      conversations,
      eq(conversations.id, messageThreadFollowers.conversationId),
    )
    .innerJoin(
      workspaceMembers,
      and(
        eq(workspaceMembers.workspaceId, conversations.workspaceId),
        eq(workspaceMembers.userId, messageThreadFollowers.userId),
      ),
    )
    .where(
      and(
        eq(messageThreadFollowers.rootMessageId, reply.parentMessageId),
        eq(messageThreadFollowers.following, true),
        ne(messageThreadFollowers.userId, reply.senderId),
        eq(users.type, "human"),
      ),
    );
  if (recipients.length === 0) return;
  await tx
    .insert(messageUnreads)
    .values(
      recipients.map(({ userId }) => ({
        messageId: reply.id,
        conversationId: reply.conversationId,
        userId,
      })),
    )
    .onConflictDoNothing();
}

/** Reply summaries for the roots among `rows` (those with replies). */
export async function threadSummariesForRows(
  rows: { id: string; replyCount?: number | null; lastReplyAt?: Date | null }[],
  executor: Pick<typeof db, "select"> = db,
): Promise<Map<string, MessageThreadSummary>> {
  const roots = rows.filter(
    (row) => (row.replyCount ?? 0) > 0 && row.lastReplyAt,
  );
  const result = new Map<string, MessageThreadSummary>();
  if (roots.length === 0) return result;

  const lastReplied = sql<string>`max(${messages.createdAt})`;
  const repliers = await executor
    .select({
      rootId: messages.parentMessageId,
      id: users.id,
      name: users.name,
      type: users.type,
      lastReplied,
    })
    .from(messages)
    .innerJoin(users, eq(users.id, messages.senderId))
    .where(inArray(messages.parentMessageId, roots.map((root) => root.id)))
    .groupBy(messages.parentMessageId, users.id, users.name, users.type)
    .orderBy(desc(lastReplied));

  const byRoot = new Map<string, MessageThreadSummary["participants"]>();
  for (const replier of repliers) {
    if (!replier.rootId) continue;
    const list = byRoot.get(replier.rootId) ?? [];
    if (list.length < THREAD_SUMMARY_PARTICIPANTS) {
      list.push({ id: replier.id, name: replier.name, type: replier.type });
    }
    byRoot.set(replier.rootId, list);
  }
  for (const root of roots) {
    result.set(root.id, {
      replyCount: root.replyCount ?? 0,
      lastReplyAt: root.lastReplyAt!.toISOString(),
      participants: byRoot.get(root.id) ?? [],
    });
  }
  return result;
}

/** The current reply summary for one root, for realtime events. */
export async function threadSummaryForRoot(
  rootId: string,
): Promise<MessageThreadSummary | null> {
  const [root] = await db
    .select({
      id: messages.id,
      replyCount: messages.replyCount,
      lastReplyAt: messages.lastReplyAt,
    })
    .from(messages)
    .where(and(eq(messages.id, rootId), gt(messages.replyCount, 0)))
    .limit(1);
  if (!root) return null;
  return (await threadSummariesForRows([root])).get(root.id) ?? null;
}

/**
 * Whether a message mentions a user. A "parts-v1" message mentions exactly
 * the users it references by ID (a typed "@Name" is plain text). A legacy
 * text message is matched by name, as before.
 */
export function messageMentionsUser(
  message: { content: string; contentFormat?: string | null; parts?: unknown },
  user: { userId: string; name: string },
) {
  if (message.contentFormat === "parts-v1") {
    return storedReferenceIds(message).includes(user.userId);
  }
  return mentionsName(message.content, user.name);
}

/**
 * Legacy mentions are stored as plain "@Display Name" text. Same rule as the
 * client's "mentions you" highlight: not after a word character, "." or "@"
 * (emails), and not followed by a word character.
 */
export function mentionsName(content: string, name: string) {
  const trimmed = name.trim();
  if (!trimmed || !content.includes("@")) return false;
  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\w.@])@${escaped}(?!\\w)`, "i").test(content);
}
