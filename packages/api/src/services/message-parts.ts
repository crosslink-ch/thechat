import { and, eq, inArray } from "drizzle-orm";
import {
  MESSAGE_PARTS_LIMITS,
  PARTS_V1,
  projectPartsContent,
  referencedUserIds,
  trimInputParts,
  type InputChatPart,
  type MessageContentFormat,
  type StoredChatPart,
} from "@thechat/shared";
import { z } from "zod";
import { db } from "../db";
import { conversationParticipants, conversations, users, workspaceMembers } from "../db/schema";
import { ServiceError } from "./errors";

/**
 * Canonical "parts-v1" message bodies: ordered text and user references.
 *
 * The server never trusts a reference. In the send transaction it checks that
 * every referenced user is a participant of the conversation (and, in a
 * workspace, still a member), resolves the label from the current name, and
 * derives the readable `content` from the parts. One invalid reference rejects
 * the whole message without saying why, so foreign IDs reveal nothing.
 */

type QueryExecutor = Pick<typeof db, "select">;

const UUID = z.string().uuid();

/** Strict wire schema for one input part: unknown fields are rejected. */
export const inputChatPartSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }).strict(),
  z
    .object({
      type: z.literal("reference"),
      refType: z.literal("user"),
      refId: UUID,
    })
    .strict(),
]);

export const inputChatPartsSchema = z
  .array(inputChatPartSchema)
  .max(MESSAGE_PARTS_LIMITS.maxParts, `A message can contain at most ${MESSAGE_PARTS_LIMITS.maxParts} parts`);

/**
 * The body fields shared by every message write path. A request authors with
 * `parts` (and `contentFormat: "parts-v1"`) or with legacy `content`, never
 * both. Callers merge these into their own schemas.
 */
export const messageBodyFields = {
  content: z.string().max(MESSAGE_PARTS_LIMITS.maxContentLength).optional(),
  contentFormat: z.literal(PARTS_V1).optional(),
  parts: inputChatPartsSchema.optional(),
};

export type MessageBody =
  | { format: "legacy-text"; content: string }
  | { format: typeof PARTS_V1; parts: InputChatPart[] };

/**
 * Resolve the authoring representation of a request, enforcing "parts or
 * content, never both". Returns null with a message for an invalid request.
 */
export function messageBodyFromRequest(input: {
  content?: string;
  contentFormat?: typeof PARTS_V1;
  parts?: InputChatPart[];
}): { body: MessageBody } | { error: string } {
  const hasParts = input.parts !== undefined || input.contentFormat !== undefined;
  if (hasParts) {
    if (input.contentFormat !== PARTS_V1 || input.parts === undefined) {
      return { error: 'Structured messages need contentFormat "parts-v1" and parts' };
    }
    if (input.content !== undefined && input.content !== "") {
      return { error: "Send either parts or content, not both" };
    }
    return { body: { format: PARTS_V1, parts: input.parts } };
  }
  return { body: { format: "legacy-text", content: input.content ?? "" } };
}

/** True when the body carries any text or reference once trimmed. */
export function messageBodyHasText(body: MessageBody) {
  return body.format === PARTS_V1
    ? trimInputParts(body.parts).length > 0
    : body.content.trim().length > 0;
}

export interface CanonicalMessageBody {
  contentFormat: MessageContentFormat;
  content: string;
  /** Stored parts for parts-v1; null for legacy text. */
  parts: StoredChatPart[] | null;
  /** Distinct referenced users, resolved; empty for legacy text. */
  references: { userId: string; type: "human" | "bot" }[];
}

/** Uniform rejection: never disclose whether an ID exists elsewhere. */
function invalidReference() {
  return new ServiceError("A mentioned person or agent is not in this conversation", 400);
}

/**
 * Canonicalize a message body inside the send transaction. Parts are trimmed
 * and merged, references validated against the conversation and resolved to
 * a label snapshot, and `content` projected from the parts.
 */
export async function canonicalizeMessageBody(
  executor: QueryExecutor,
  conversationId: string,
  body: MessageBody,
): Promise<CanonicalMessageBody> {
  if (body.format !== PARTS_V1) {
    return {
      contentFormat: "legacy-text",
      content: body.content.trim(),
      parts: null,
      references: [],
    };
  }

  const parts = trimInputParts(body.parts);
  const occurrences = parts.filter((part) => part.type === "reference").length;
  if (occurrences > MESSAGE_PARTS_LIMITS.maxReferences) {
    throw new ServiceError(
      `A message can mention at most ${MESSAGE_PARTS_LIMITS.maxReferences} times`,
      400,
    );
  }
  const ids = referencedUserIds(parts);
  const resolved = await resolveConversationReferences(executor, conversationId, ids);

  const stored: StoredChatPart[] = parts.map((part) => {
    if (part.type === "text") return part;
    const target = resolved.get(part.refId)!;
    return {
      type: "reference",
      refType: "user",
      refId: part.refId,
      label: target.name,
      targetType: target.type,
    };
  });
  const content = projectPartsContent(stored);
  if (content.length > MESSAGE_PARTS_LIMITS.maxContentLength) {
    throw new ServiceError("Message is too long", 400);
  }
  return {
    contentFormat: PARTS_V1,
    content,
    parts: stored.length > 0 ? stored : null,
    references: ids.map((id) => ({ userId: id, type: resolved.get(id)!.type })),
  };
}

/**
 * Every referenced user must be a participant of the conversation and, for a
 * workspace conversation, a current member of that workspace.
 */
async function resolveConversationReferences(
  executor: QueryExecutor,
  conversationId: string,
  ids: string[],
) {
  const resolved = new Map<string, { name: string; type: "human" | "bot" }>();
  if (ids.length === 0) return resolved;
  const [conversation] = await executor
    .select({ workspaceId: conversations.workspaceId })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);
  if (!conversation) throw invalidReference();

  const rows = await executor
    .select({ userId: users.id, name: users.name, type: users.type })
    .from(conversationParticipants)
    .innerJoin(users, eq(users.id, conversationParticipants.userId))
    .where(
      and(
        eq(conversationParticipants.conversationId, conversationId),
        inArray(conversationParticipants.userId, ids),
      ),
    );
  const members = conversation.workspaceId
    ? new Set(
        (
          await executor
            .select({ userId: workspaceMembers.userId })
            .from(workspaceMembers)
            .where(
              and(
                eq(workspaceMembers.workspaceId, conversation.workspaceId),
                inArray(workspaceMembers.userId, ids),
              ),
            )
        ).map((row) => row.userId),
      )
    : null;
  for (const row of rows) {
    if (members && !members.has(row.userId)) continue;
    resolved.set(row.userId, { name: row.name, type: row.type });
  }
  if (ids.some((id) => !resolved.has(id))) throw invalidReference();
  return resolved;
}

/** The referenced user IDs of a stored parts-v1 message (empty otherwise). */
export function storedReferenceIds(message: {
  contentFormat?: string | null;
  parts?: unknown;
}): string[] {
  if (message.contentFormat !== PARTS_V1 || !Array.isArray(message.parts)) return [];
  return referencedUserIds(message.parts as StoredChatPart[]);
}

/** Stored parts in a form comparable with an incoming command. */
export function storedPartsSignature(message: {
  contentFormat?: string | null;
  parts?: unknown;
}): string | null {
  if (message.contentFormat !== PARTS_V1) return null;
  const parts = Array.isArray(message.parts) ? (message.parts as StoredChatPart[]) : [];
  return JSON.stringify(
    parts.map((part) =>
      part.type === "text" ? ["t", part.text] : ["r", part.refType, part.refId],
    ),
  );
}
