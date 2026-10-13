import { ServiceError } from './errors';
import { eq, sql } from 'drizzle-orm';
import { db } from '../db';
import { messages } from '../db/schema';

export type MessageCursor = { timestamp: string; id: string; conversationId: string; threadId: string | null };
const prefix = 'm1.';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function encodeMessageCursor(cursor: MessageCursor) {
  return prefix+Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

/** Realtime/REST sends also need precise cursors when the client trims all
 * fetched history and its oldest retained boundary came from a live echo. */
export async function persistedMessageCursor(messageId: string) {
  const [row]=await db.select({
    id: messages.id, conversationId: messages.conversationId, threadId: messages.threadId,
    timestamp: sql<string>`to_char(${messages.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
  }).from(messages).where(eq(messages.id,messageId)).limit(1);
  return row ? encodeMessageCursor(row) : undefined;
}

/** Exact PostgreSQL microseconds survive JavaScript Date/wire precision loss.
 * Timestamp-only legacy clients deliberately retain their strictly-before-time
 * semantics; updated clients send the returned versioned paginationCursor. */
export function decodeMessageCursor(value: string, conversationId: string, threadId?: string, unthreaded?: boolean): MessageCursor | Date {
  if (!value.startsWith(prefix)) {
    if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d:\d\d)$/.test(value)) throw new ServiceError('Invalid message pagination cursor',400);
    const timestamp=new Date(value);
    if (!Number.isFinite(timestamp.getTime())) throw new ServiceError('Invalid message pagination cursor',400);
    return timestamp;
  }
  try {
    if (value.length>1000 || !/^[A-Za-z0-9_-]+$/.test(value.slice(prefix.length))) throw new Error('encoding');
    const cursor: MessageCursor = JSON.parse(Buffer.from(value.slice(prefix.length),'base64url').toString('utf8'));
    if (!cursor || typeof cursor.timestamp!=='string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(cursor.timestamp) || !Number.isFinite(new Date(cursor.timestamp).getTime())
      || !uuid.test(cursor.id) || cursor.conversationId!==conversationId || !(cursor.threadId===null || uuid.test(cursor.threadId))
      || threadId && cursor.threadId!==threadId || unthreaded && cursor.threadId!==null) throw new Error('scope or value');
    return cursor;
  } catch { throw new ServiceError('Invalid message pagination cursor',400); }
}
