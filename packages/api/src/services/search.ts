import { SEARCH_RESULT_CAP, type SearchPage } from "@thechat/shared";
import type { ChatMessage, SearchDestination, SearchMessageResult, SearchMessageContext, SearchJumpOptions } from "@thechat/shared";
import { sql } from "drizzle-orm";
import { db } from "../db";
import { ServiceError } from "./errors";
import { attachmentsByMessageIds } from "../attachments/public";
import { messageReactionsByMessageIds } from "./message-reactions";

// All search scopes come from the database, never a client-provided ID list.
function accessibleConversations(userId: string) {
  return sql`SELECT c.id, c.type, c.workspace_id, w.name AS workspace_name,
    c.updated_at,
    CASE WHEN c.type = 'direct' THEN other_user.name
      ELSE coalesce(c.title, c.name, 'Channel') END AS conversation_name,
    CASE WHEN c.type = 'direct' THEN other_user.type ELSE NULL END AS participant_type
    FROM conversations c
    JOIN workspace_members wm ON wm.workspace_id = c.workspace_id AND wm.user_id = ${userId}
    JOIN conversation_participants cp ON cp.conversation_id = c.id AND cp.user_id = ${userId}
    JOIN workspaces w ON w.id = c.workspace_id
    LEFT JOIN LATERAL (
      SELECT u.name, u.type FROM conversation_participants other_cp
      JOIN users u ON u.id = other_cp.user_id
      WHERE other_cp.conversation_id = c.id AND other_cp.user_id <> ${userId}
      ORDER BY u.id LIMIT 1
    ) other_user ON c.type = 'direct'
    -- Legacy extra-participant DMs have ambiguous ownership. Never repair on a read.
    WHERE c.type <> 'direct' OR (SELECT count(*) FROM conversation_participants exact_pair
      WHERE exact_pair.conversation_id = c.id) = 2`;
}

export async function searchJump(userId: string, options: SearchJumpOptions = {}): Promise<SearchPage<SearchDestination>> {
  const { kind = "all", workspaceId = "" } = options;
  const q = (options.q ?? "").trim().toLowerCase();
  const offset = Number(options.offset ?? 0);
  const limit = Math.min(Number(options.limit ?? 30), SEARCH_RESULT_CAP - offset);
  const escaped = escapeLike(q);
  const fuzzy = `%${[...q].map(escapeLike).join("%")}%`;
  const rows = await db.execute(sql`WITH accessible AS (${accessibleConversations(userId)}), destinations AS (
    SELECT id AS conversation_id, NULL::uuid AS thread_id, CASE WHEN type = 'direct' THEN 'dm' ELSE 'channel' END AS kind,
      type AS conversation_type, workspace_id, workspace_name, conversation_name AS title, conversation_name, participant_type, updated_at
    FROM accessible
    UNION ALL
    SELECT a.id, t.id, 'task', a.type, a.workspace_id, a.workspace_name, t.title, a.conversation_name,
      a.participant_type, greatest(t.last_activity_at, t.updated_at)
    FROM accessible a JOIN conversation_threads t ON t.conversation_id = a.id
  ), ranked AS (
    SELECT *, CASE
      WHEN ${q} = '' OR lower(title) = ${q} THEN 0
      WHEN lower(title) LIKE ${escaped + "%"} THEN 1
      WHEN lower(title) LIKE ${"%" + escaped + "%"} THEN 2
      WHEN lower(title) LIKE ${fuzzy} THEN 3
      WHEN kind = 'task' AND lower(conversation_name) LIKE ${fuzzy} THEN 4
      ELSE 5 END AS rank
    FROM destinations WHERE (${kind} = 'all' OR kind = ${kind})
  ) SELECT conversation_id AS "conversationId", thread_id AS "threadId", kind, conversation_type AS "conversationType",
      workspace_id AS "workspaceId", workspace_name AS "workspaceName", title,
      conversation_name AS "conversationName", participant_type AS "participantType", updated_at AS "updatedAt"
    FROM ranked WHERE rank < 5
    ORDER BY rank, CASE WHEN ${q} <> '' AND workspace_id = ${workspaceId} THEN 0 ELSE 1 END,
      CASE WHEN ${q} = '' THEN array_position(string_to_array(${options.recentIds ?? ""}, ','),
        kind || ':' || coalesce(thread_id, conversation_id)::text) END ASC NULLS LAST,
      updated_at DESC, kind, conversation_id, thread_id LIMIT ${limit + 1} OFFSET ${offset}`);
  return { items: rows.slice(0, limit).map(row => ({ ...row, id: `${row.kind}:${row.threadId ?? row.conversationId}`,
    updatedAt: new Date(row.updatedAt as string).toISOString() } as SearchDestination)), hasMore: rows.length > limit && offset + limit < SEARCH_RESULT_CAP,
    ...(offset + limit >= SEARCH_RESULT_CAP ? { truncated: rows.length > limit } : {}) };
}

// LIKE patterns use backslash escaping; user punctuation never becomes SQL wildcards.
function escapeLike(value: string) {
  return value.replace(/[\\%_]/g, "\\$&");
}

export async function searchMessages(userId: string, q: string, limit = 20, offset = 0): Promise<SearchPage<SearchMessageResult>> {
  limit = Math.min(limit, SEARCH_RESULT_CAP - offset);
  const pattern = `%${escapeLike(q.trim().toLowerCase())}%`;
  const rows = await db.execute(sql`WITH accessible AS (${accessibleConversations(userId)})
    SELECT m.id, m.conversation_id AS "conversationId", m.thread_id AS "threadId",
      a.workspace_id AS "workspaceId", a.workspace_name AS "workspaceName",
      a.conversation_name AS "conversationName", a.type AS "conversationType",
      t.title AS "threadTitle", u.name AS "senderName", u.type AS "senderType",
      m.content, m.created_at AS "createdAt"
    FROM messages m JOIN accessible a ON a.id = m.conversation_id
    JOIN users u ON u.id = m.sender_id
    LEFT JOIN conversation_threads t ON t.id = m.thread_id AND t.conversation_id = m.conversation_id
    WHERE lower(m.content) LIKE ${pattern}
      AND (m.thread_id IS NULL OR t.id IS NOT NULL)
    ORDER BY m.created_at DESC, m.id DESC LIMIT ${limit + 1} OFFSET ${offset}`);
  return { items: rows.slice(0, limit).map(row => ({ ...row, content: messageSnippet(row.content as string, q), createdAt: new Date(row.createdAt as string).toISOString() } as SearchMessageResult)), hasMore: rows.length > limit && offset + limit < SEARCH_RESULT_CAP,
    ...(offset + limit >= SEARCH_RESULT_CAP ? { truncated: rows.length > limit } : {}) };
}

/** Text only: no parts, HTML highlighting, attachments, or signed URLs. */
function messageSnippet(content: string, q: string) {
  const match = Math.max(0, content.toLowerCase().indexOf(q.trim().toLowerCase()));
  const start = Math.max(0, match - 100);
  const end = Math.min(content.length, start + 318);
  return `${start ? "…" : ""}${content.slice(start, end)}${end < content.length ? "…" : ""}`;
}

export async function searchMessageContext(userId: string, messageId: string): Promise<SearchMessageContext> {
  // One statement: authorization, target and both windows share a DB snapshot.
  // Compare native timestamp+UUID tuples, retaining PostgreSQL microseconds.
  const rows = await db.execute(sql`WITH accessible AS (${accessibleConversations(userId)}), target AS (
    SELECT m.* FROM messages m JOIN accessible a ON a.id = m.conversation_id
    WHERE m.id = ${messageId}::uuid AND (m.thread_id IS NULL OR EXISTS (
      SELECT 1 FROM conversation_threads t WHERE t.id = m.thread_id AND t.conversation_id = m.conversation_id
    ))
  ), context_rows AS (
    (SELECT m.id, m.conversation_id, m.thread_id, m.sender_id, m.content, m.created_at, -1 AS side
      FROM messages m JOIN target t ON m.conversation_id = t.conversation_id
        AND m.thread_id IS NOT DISTINCT FROM t.thread_id
      WHERE (m.created_at, m.id) < (t.created_at, t.id)
      ORDER BY m.created_at DESC, m.id DESC LIMIT 21)
    UNION ALL
    SELECT id, conversation_id, thread_id, sender_id, content, created_at, 0 FROM target
    UNION ALL
    (SELECT m.id, m.conversation_id, m.thread_id, m.sender_id, m.content, m.created_at, 1
      FROM messages m JOIN target t ON m.conversation_id = t.conversation_id
        AND m.thread_id IS NOT DISTINCT FROM t.thread_id
      WHERE (m.created_at, m.id) > (t.created_at, t.id)
      ORDER BY m.created_at, m.id LIMIT 21)
  ) SELECT w.id, w.conversation_id AS "conversationId", w.thread_id AS "threadId",
      w.sender_id AS "senderId", w.content, w.created_at AS "createdAt", w.side,
      u.name AS "senderName", u.type AS "senderType"
    FROM context_rows w JOIN users u ON u.id = w.sender_id ORDER BY w.created_at, w.id`);
  const target = rows.find(row => row.side === 0);
  if (!target) throw new ServiceError("Message not found", 404);
  const older = rows.filter(row => row.side === -1);
  const newer = rows.filter(row => row.side === 1);
  const page = [...older.slice(-20), target, ...newer.slice(0, 20)];
  const ids = page.map(row => row.id as string);
  const [attachmentMap, reactionMap] = await Promise.all([
    attachmentsByMessageIds(ids, { conversationId: target.conversationId as string }), messageReactionsByMessageIds(ids, userId),
  ]);
  return {
    conversationId: target.conversationId as string, threadId: target.threadId as string | null,
    messages: page.map(({ side: _side, ...row }) => ({ ...row, attachments: attachmentMap.get(row.id as string) ?? [],
      reactions: reactionMap.get(row.id as string) ?? [],
      createdAt: new Date(row.createdAt as string).toISOString() } as ChatMessage)),
    hasOlder: older.length > 20, hasNewer: newer.length > 20,
  };
}
