import { and, asc, desc, eq, gte, ilike, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  parseMessageSearchTerms,
  resolveBotAppearance,
  scoreSearchMatch,
  type ChatMessage,
  type MessageContext,
  type MessageSearchHit,
  type MessageSearchPage,
  type SearchDestination,
} from "@thechat/shared";
import { attachmentsByMessageIds } from "../attachments/public";
import { db } from "../db";
import {
  bots,
  conversationParticipants,
  conversationThreads,
  conversations,
  messages,
  users,
  workspaceMembers,
  workspaces,
} from "../db/schema";
import { withSpan } from "../observability";
import { ServiceError } from "./errors";
import { messageReactionsByMessageIds } from "./message-reactions";
import { canUserAccessAttachments, toChatMessage } from "./messages";
import { threadSummariesForRows } from "./message-threads";

export const MESSAGE_SEARCH_DEFAULT_LIMIT = 20;
export const MESSAGE_SEARCH_MAX_LIMIT = 50;
export const MESSAGE_CONTEXT_MAX = 50;
const MAX_SEARCH_TERMS = 8;
const MAX_QUERY_LENGTH = 500;
const DIRECTORY_TASK_LIMIT = 200;
const SNIPPET_RADIUS = 80;

/** A conversation the user may read right now, named the way the UI names it. */
interface AccessibleConversation {
  id: string;
  type: "direct" | "group";
  /** Channel name, or the other participant's name for a DM. */
  name: string;
  workspaceId: string;
  workspaceName: string;
  otherUserId: string | null;
  /** A DM with a Hermes bot shows its messages per task (thread). */
  hermesDm: boolean;
}

/**
 * Conversations the user takes part in, in workspaces they still belong to.
 * This is the one access rule every search uses: a removed member loses
 * their former channels and DMs, and a DM is only searchable by its pair.
 * Direct conversations that do not have exactly two participants (left over
 * from older builds) are excluded, as the DM list excludes them.
 */
async function accessibleConversations(
  userId: string,
  filter: { workspaceId?: string | null; conversationId?: string | null } = {},
) {
  const rows = await db
    .select({
      id: conversations.id,
      type: conversations.type,
      name: conversations.name,
      workspaceId: workspaces.id,
      workspaceName: workspaces.name,
    })
    .from(conversationParticipants)
    .innerJoin(conversations, eq(conversations.id, conversationParticipants.conversationId))
    .innerJoin(workspaces, eq(workspaces.id, conversations.workspaceId))
    .innerJoin(
      workspaceMembers,
      and(
        eq(workspaceMembers.workspaceId, conversations.workspaceId),
        eq(workspaceMembers.userId, userId),
      ),
    )
    .where(
      and(
        eq(conversationParticipants.userId, userId),
        filter.workspaceId ? eq(conversations.workspaceId, filter.workspaceId) : undefined,
        filter.conversationId ? eq(conversations.id, filter.conversationId) : undefined,
      ),
    );

  const directIds = rows.filter((row) => row.type === "direct").map((row) => row.id);
  const participants = directIds.length
    ? await db
        .select({
          conversationId: conversationParticipants.conversationId,
          userId: users.id,
          name: users.name,
          botKind: bots.kind,
        })
        .from(conversationParticipants)
        .innerJoin(users, eq(users.id, conversationParticipants.userId))
        .leftJoin(bots, eq(bots.userId, users.id))
        .where(inArray(conversationParticipants.conversationId, directIds))
    : [];
  const participantsByConversation = new Map<string, typeof participants>();
  for (const participant of participants) {
    const list = participantsByConversation.get(participant.conversationId) ?? [];
    list.push(participant);
    participantsByConversation.set(participant.conversationId, list);
  }

  const result = new Map<string, AccessibleConversation>();
  for (const row of rows) {
    if (row.type === "group") {
      result.set(row.id, {
        id: row.id,
        type: "group",
        name: row.name ?? "channel",
        workspaceId: row.workspaceId,
        workspaceName: row.workspaceName,
        otherUserId: null,
        hermesDm: false,
      });
      continue;
    }
    const pair = participantsByConversation.get(row.id) ?? [];
    const other = pair.find((participant) => participant.userId !== userId);
    if (pair.length !== 2 || !other) continue;
    result.set(row.id, {
      id: row.id,
      type: "direct",
      name: other.name,
      workspaceId: row.workspaceId,
      workspaceName: row.workspaceName,
      otherUserId: other.userId,
      hermesDm: other.botKind === "hermes",
    });
  }
  return result;
}

// -- Message search --

export interface MessageSearchOptions {
  query: string;
  workspaceId?: string | null;
  conversationId?: string | null;
  threadId?: string | null;
  senderId?: string | null;
  after?: string | null;
  before?: string | null;
  cursor?: string | null;
  limit?: number | null;
}

interface MessageCursor {
  /** Postgres' own text form of created_at: exact to the microsecond. */
  createdAt: string;
  id: string;
}

function encodeCursor(cursor: MessageCursor) {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Postgres' timestamptz text, e.g. "2026-10-01 12:00:00.123456+00".
const PG_TIMESTAMPTZ = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:\d{2}){0,2}$/;

function parseCursor(value: string | null | undefined): MessageCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      typeof parsed?.createdAt !== "string" ||
      !PG_TIMESTAMPTZ.test(parsed.createdAt) ||
      typeof parsed?.id !== "string" ||
      !UUID.test(parsed.id)
    ) {
      throw new Error("invalid");
    }
    return { createdAt: parsed.createdAt, id: parsed.id };
  } catch {
    throw new ServiceError("Invalid search cursor", 400);
  }
}

function parseDate(value: string | null | undefined, name: string) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new ServiceError(`${name} must be an ISO date or timestamp`, 400);
  }
  return date;
}

/** `%` and `_` in a search are literal characters, not wildcards. */
function likePattern(term: string) {
  return `%${term.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

/** A one-line excerpt centred on the earliest matching term. */
export function messageSnippet(content: string, terms: string[]) {
  const flat = content.replace(/\s+/g, " ").trim();
  const lower = flat.toLowerCase();
  let index = -1;
  let length = 0;
  for (const term of terms) {
    const found = lower.indexOf(term.toLowerCase());
    if (found >= 0 && (index < 0 || found < index)) {
      index = found;
      length = term.length;
    }
  }
  if (index < 0) {
    return flat.length > SNIPPET_RADIUS * 2 ? `${flat.slice(0, SNIPPET_RADIUS * 2)}…` : flat;
  }
  let start = Math.max(0, index - SNIPPET_RADIUS);
  let end = Math.min(flat.length, index + length + SNIPPET_RADIUS);
  // Do not cut words in half at either edge.
  if (start > 0) {
    const space = flat.indexOf(" ", start);
    if (space >= 0 && space < index) start = space + 1;
  }
  if (end < flat.length) {
    const space = flat.lastIndexOf(" ", end);
    if (space > index + length) end = space;
  }
  return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`;
}

/**
 * Messages the user can read that contain every term, newest first.
 * Matching is case-insensitive and literal; a trigram index keeps it fast
 * on large histories. Agent progress updates are never results.
 */
export async function searchMessages(
  userId: string,
  options: MessageSearchOptions,
): Promise<MessageSearchPage> {
  const query = options.query.trim();
  if (query.length > MAX_QUERY_LENGTH) {
    throw new ServiceError(`Search text is limited to ${MAX_QUERY_LENGTH} characters`, 400);
  }
  const terms = parseMessageSearchTerms(query);
  if (terms.join("").length < 2) {
    throw new ServiceError("Search for at least 2 characters", 400);
  }
  if (terms.length > MAX_SEARCH_TERMS) {
    throw new ServiceError(`Use at most ${MAX_SEARCH_TERMS} search terms`, 400);
  }
  if (options.threadId && !options.conversationId) {
    throw new ServiceError("threadId requires conversationId", 400);
  }
  const limit = Math.min(
    Math.max(Math.trunc(options.limit ?? MESSAGE_SEARCH_DEFAULT_LIMIT), 1),
    MESSAGE_SEARCH_MAX_LIMIT,
  );
  const cursor = parseCursor(options.cursor);
  const after = parseDate(options.after, "after");
  const before = parseDate(options.before, "before");

  return withSpan(
    "search.messages",
    {
      "search.terms": terms.length,
      "search.limit": limit,
      "search.paged": cursor !== null,
      "search.scope": options.conversationId
        ? "conversation"
        : options.workspaceId
          ? "workspace"
          : "all",
    },
    async (span) => {
      const accessible = await accessibleConversations(userId, {
        workspaceId: options.workspaceId,
        conversationId: options.conversationId,
      });
      if (options.conversationId && !accessible.has(options.conversationId)) {
        throw new ServiceError("Conversation not found", 404);
      }
      span.setAttribute("search.conversations", accessible.size);
      if (accessible.size === 0) return { results: [], nextCursor: null };

      const rows = await db
        .select({
          id: messages.id,
          conversationId: messages.conversationId,
          threadId: messages.threadId,
          parentMessageId: messages.parentMessageId,
          senderId: messages.senderId,
          content: messages.content,
          createdAt: messages.createdAt,
          createdAtKey: sql<string>`${messages.createdAt}::text`,
          senderName: users.name,
          senderType: users.type,
          threadTitle: conversationThreads.title,
        })
        .from(messages)
        .innerJoin(users, eq(users.id, messages.senderId))
        .leftJoin(conversationThreads, eq(conversationThreads.id, messages.threadId))
        .where(
          and(
            inArray(messages.conversationId, [...accessible.keys()]),
            eq(messages.interim, false),
            ...terms.map((term) => ilike(messages.content, likePattern(term))),
            options.threadId ? eq(messages.threadId, options.threadId) : undefined,
            options.senderId ? eq(messages.senderId, options.senderId) : undefined,
            after ? gte(messages.createdAt, after) : undefined,
            before ? lt(messages.createdAt, before) : undefined,
            cursor
              ? sql`(${messages.createdAt}, ${messages.id}) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`
              : undefined,
          ),
        )
        .orderBy(desc(messages.createdAt), desc(messages.id))
        .limit(limit + 1);

      const page = rows.slice(0, limit);
      span.setAttribute("search.results", page.length);
      const results: MessageSearchHit[] = page.map((row) => {
        const conversation = accessible.get(row.conversationId)!;
        return {
          id: row.id,
          conversationId: row.conversationId,
          conversationType: conversation.type,
          conversationName: conversation.name,
          workspaceId: conversation.workspaceId,
          workspaceName: conversation.workspaceName,
          threadId: row.threadId,
          threadTitle: row.threadTitle ?? null,
          ...(row.parentMessageId ? { parentMessageId: row.parentMessageId } : {}),
          senderId: row.senderId,
          senderName: row.senderName,
          senderType: row.senderType,
          snippet: messageSnippet(row.content, terms),
          createdAt: row.createdAt.toISOString(),
        };
      });
      const last = page.at(-1);
      return {
        results,
        nextCursor:
          rows.length > limit && last
            ? encodeCursor({ createdAt: last.createdAtKey, id: last.id })
            : null,
      };
    },
  );
}

// -- Quick switcher destinations --

async function recentTasks(
  conversationsById: Map<string, AccessibleConversation>,
  options: { title?: string; limit: number },
) {
  const hermesDmIds = [...conversationsById.values()]
    .filter((conversation) => conversation.hermesDm)
    .map((conversation) => conversation.id);
  if (hermesDmIds.length === 0 || options.limit <= 0) return [];
  const rows = await db
    .select({
      id: conversationThreads.id,
      conversationId: conversationThreads.conversationId,
      title: conversationThreads.title,
      lastActivityAt: conversationThreads.lastActivityAt,
    })
    .from(conversationThreads)
    .where(
      and(
        inArray(conversationThreads.conversationId, hermesDmIds),
        options.title ? ilike(conversationThreads.title, likePattern(options.title)) : undefined,
      ),
    )
    .orderBy(desc(conversationThreads.lastActivityAt), desc(conversationThreads.id))
    .limit(options.limit);
  return rows.map((row): SearchDestination => {
    const conversation = conversationsById.get(row.conversationId)!;
    return {
      kind: "task",
      conversationId: row.conversationId,
      conversationName: conversation.name,
      threadId: row.id,
      title: row.title,
      workspaceId: conversation.workspaceId,
      workspaceName: conversation.workspaceName,
      lastActivityAt: row.lastActivityAt.toISOString(),
    };
  });
}

/**
 * Everything the quick switcher can jump to by name, across all of the
 * user's workspaces: channels, people and bots, and their recent Hermes
 * tasks. Clients cache it and filter locally, so typing costs no requests.
 */
export async function getSearchDirectory(
  userId: string,
  options: { workspaceId?: string | null; taskLimit?: number } = {},
): Promise<SearchDestination[]> {
  return withSpan("search.directory", {}, async (span) => {
    const accessible = await accessibleConversations(userId, {
      workspaceId: options.workspaceId,
    });
    const myMembership = alias(workspaceMembers, "search_my_membership");
    const [members, tasks] = await Promise.all([
      db
        .select({
          workspaceId: workspaces.id,
          workspaceName: workspaces.name,
          userId: users.id,
          name: users.name,
          type: users.type,
          botKind: bots.kind,
          avatarShape: bots.avatarShape,
          avatarColor: bots.avatarColor,
        })
        .from(workspaceMembers)
        .innerJoin(
          myMembership,
          and(
            eq(myMembership.workspaceId, workspaceMembers.workspaceId),
            eq(myMembership.userId, userId),
          ),
        )
        .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
        .innerJoin(users, eq(users.id, workspaceMembers.userId))
        .leftJoin(bots, eq(bots.userId, users.id))
        .where(
          and(
            ne(workspaceMembers.userId, userId),
            options.workspaceId ? eq(workspaceMembers.workspaceId, options.workspaceId) : undefined,
          ),
        )
        .orderBy(asc(workspaces.name), asc(users.name)),
      recentTasks(accessible, { limit: options.taskLimit ?? DIRECTORY_TASK_LIMIT }),
    ]);

    const directByPair = new Map<string, string>();
    for (const conversation of accessible.values()) {
      if (conversation.type === "direct" && conversation.otherUserId) {
        directByPair.set(`${conversation.workspaceId}:${conversation.otherUserId}`, conversation.id);
      }
    }

    const channels = [...accessible.values()]
      .filter((conversation) => conversation.type === "group")
      .sort((a, b) => a.workspaceName.localeCompare(b.workspaceName) || a.name.localeCompare(b.name))
      .map((conversation): SearchDestination => ({
        kind: "channel",
        conversationId: conversation.id,
        name: conversation.name,
        workspaceId: conversation.workspaceId,
        workspaceName: conversation.workspaceName,
      }));
    const people = members.map((member): SearchDestination => ({
      kind: "person",
      userId: member.userId,
      name: member.name,
      userType: member.type,
      botKind: member.botKind ?? null,
      botAvatar:
        member.type === "bot"
          ? resolveBotAppearance(member.userId, {
              avatarShape: member.avatarShape,
              avatarColor: member.avatarColor,
            })
          : null,
      workspaceId: member.workspaceId,
      workspaceName: member.workspaceName,
      conversationId: directByPair.get(`${member.workspaceId}:${member.userId}`) ?? null,
    }));
    span.setAttribute("search.channels", channels.length);
    span.setAttribute("search.people", people.length);
    span.setAttribute("search.tasks", tasks.length);
    return [...channels, ...people, ...tasks];
  });
}

/** Hermes tasks whose title contains `query`, most recently active first. */
export async function searchTasks(
  userId: string,
  query: string,
  options: { workspaceId?: string | null; limit?: number } = {},
) {
  const title = query.trim();
  if (title.length < 2) throw new ServiceError("Search for at least 2 characters", 400);
  const accessible = await accessibleConversations(userId, { workspaceId: options.workspaceId });
  return recentTasks(accessible, { title, limit: Math.min(Math.max(options.limit ?? 20, 1), 50) });
}

export type DestinationKind = SearchDestination["kind"];

function destinationName(destination: SearchDestination) {
  return destination.kind === "task" ? destination.title : destination.name;
}

/**
 * Destinations named like `query`, best match first: what an agent uses to
 * turn "the marketing channel" or "my DM with Simon" into IDs.
 */
export async function findDestinations(
  userId: string,
  query: string,
  options: { kinds?: DestinationKind[]; workspaceId?: string | null; limit?: number } = {},
) {
  const text = query.trim();
  if (!text) throw new ServiceError("Search text is required", 400);
  const limit = Math.min(Math.max(options.limit ?? 10, 1), 50);
  const wanted = new Set<DestinationKind>(options.kinds?.length ? options.kinds : ["channel", "person", "task"]);
  const [directory, tasks] = await Promise.all([
    getSearchDirectory(userId, { workspaceId: options.workspaceId, taskLimit: 0 }),
    wanted.has("task") && text.length >= 2
      ? searchTasks(userId, text, { workspaceId: options.workspaceId, limit: 50 })
      : Promise.resolve([]),
  ]);
  return [...directory, ...tasks]
    .filter((destination) => wanted.has(destination.kind))
    .map((destination) => ({ destination, score: scoreSearchMatch(text, destinationName(destination)) }))
    .filter((entry): entry is { destination: SearchDestination; score: number } => entry.score !== null)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.destination);
}

// -- Message context --

const contextColumns = {
  id: messages.id,
  conversationId: messages.conversationId,
  threadId: messages.threadId,
  parentMessageId: messages.parentMessageId,
  alsoSentToConversation: messages.alsoSentToConversation,
  replyCount: messages.replyCount,
  lastReplyAt: messages.lastReplyAt,
  senderId: messages.senderId,
  content: messages.content,
  parts: messages.parts,
  interim: messages.interim,
  createdAt: messages.createdAt,
  senderName: users.name,
  senderType: users.type,
};

/**
 * The messages around one message, in the scope its conversation shows: a
 * Hermes DM shows one task (or General) at a time, everything else shows
 * the whole conversation. Unknown and unreadable messages are both 404.
 */
export async function getMessageContext(
  userId: string,
  messageId: string,
  options: { before?: number; after?: number } = {},
): Promise<MessageContext> {
  const beforeCount = Math.min(Math.max(Math.trunc(options.before ?? 20), 0), MESSAGE_CONTEXT_MAX);
  const afterCount = Math.min(Math.max(Math.trunc(options.after ?? 20), 0), MESSAGE_CONTEXT_MAX);
  return withSpan("search.message_context", { "search.before": beforeCount, "search.after": afterCount }, async () => {
    const [target] = await db
      .select({
        id: messages.id,
        conversationId: messages.conversationId,
        threadId: messages.threadId,
        parentMessageId: messages.parentMessageId,
        alsoSentToConversation: messages.alsoSentToConversation,
        createdAtKey: sql<string>`${messages.createdAt}::text`,
      })
      .from(messages)
      .where(eq(messages.id, messageId))
      .limit(1);
    const notFound = new ServiceError("Message not found", 404);
    if (!target) throw notFound;
    const conversation = (
      await accessibleConversations(userId, { conversationId: target.conversationId })
    ).get(target.conversationId);
    if (!conversation) throw notFound;

    // A reply that stayed in its thread is shown among its thread (root
    // first); everything else among the conversation's main timeline.
    const replyRootId =
      target.parentMessageId && !target.alsoSentToConversation ? target.parentMessageId : null;
    const scope = replyRootId
      ? or(eq(messages.parentMessageId, replyRootId), eq(messages.id, replyRootId))
      : and(
          eq(messages.conversationId, conversation.id),
          or(isNull(messages.parentMessageId), eq(messages.alsoSentToConversation, true)),
          conversation.hermesDm
            ? target.threadId
              ? eq(messages.threadId, target.threadId)
              : isNull(messages.threadId)
            : undefined,
        );
    const position = sql`(${messages.createdAt}, ${messages.id})`;
    const anchor = sql`(${target.createdAtKey}::timestamptz, ${target.id}::uuid)`;
    const [older, newer, [targetRow], thread] = await Promise.all([
      db
        .select(contextColumns)
        .from(messages)
        .innerJoin(users, eq(users.id, messages.senderId))
        .where(and(scope, sql`${position} < ${anchor}`))
        .orderBy(desc(messages.createdAt), desc(messages.id))
        .limit(beforeCount + 1),
      db
        .select(contextColumns)
        .from(messages)
        .innerJoin(users, eq(users.id, messages.senderId))
        .where(and(scope, sql`${position} > ${anchor}`))
        .orderBy(asc(messages.createdAt), asc(messages.id))
        .limit(afterCount + 1),
      db
        .select(contextColumns)
        .from(messages)
        .innerJoin(users, eq(users.id, messages.senderId))
        .where(eq(messages.id, target.id))
        .limit(1),
      target.threadId
        ? db
            .select({ title: conversationThreads.title })
            .from(conversationThreads)
            .where(eq(conversationThreads.id, target.threadId))
            .limit(1)
        : Promise.resolve([]),
    ]);
    if (!targetRow) throw notFound;

    const rows = [
      ...older.slice(0, beforeCount).reverse(),
      targetRow,
      ...newer.slice(0, afterCount),
    ];
    const ids = rows.map((row) => row.id);
    const [attachmentMap, reactionMap, threadMap] = await Promise.all([
      canUserAccessAttachments(db, userId).then((allowed) =>
        allowed ? attachmentsByMessageIds(ids) : new Map<string, NonNullable<ChatMessage["attachments"]>>(),
      ),
      messageReactionsByMessageIds(ids, userId),
      threadSummariesForRows(rows),
    ]);
    return {
      conversation: {
        id: conversation.id,
        type: conversation.type,
        name: conversation.name,
        workspaceId: conversation.workspaceId,
        workspaceName: conversation.workspaceName,
      },
      threadId: target.threadId,
      threadTitle: thread[0]?.title ?? null,
      ...(replyRootId ? { replyRootId } : {}),
      targetMessageId: target.id,
      messages: rows.map((row) =>
        toChatMessage(
          row,
          attachmentMap.get(row.id) ?? [],
          reactionMap.get(row.id) ?? [],
          threadMap.get(row.id),
        ),
      ),
      hasOlder: older.length > beforeCount,
      hasNewer: newer.length > afterCount,
    };
  });
}
