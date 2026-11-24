import crypto from "node:crypto";
import { and, asc, desc, eq, gt, inArray, isNull, lt, ne, sql } from "drizzle-orm";
import type {
  ChatMessage,
  FollowedThread,
  FollowedThreadsPage,
  MessageThreadPage,
  MessageThreadSummary,
  TaskMessagePage,
  WsServerEvent,
} from "@thechat/shared";
import { attachmentsByMessageIds } from "../attachments/public";
import { loadAttachmentConfig } from "../attachments/config";
import { db } from "../db";
import {
  attachments,
  bots,
  conversationParticipants,
  conversationThreads,
  conversations,
  messageAttachments,
  messages,
  messageThreadFollowers,
  messageUnreads,
  users,
  workspaceMembers,
  workspaces,
} from "../db/schema";
import { createChatMessageSentV1 } from "../events/envelope";
import { enqueueDomainEvent } from "../events/outbox";
import { log } from "../logging";
import { withSpan } from "../observability";
import { publishWsEventToUsers } from "../realtime";
import { ServiceError } from "./errors";
import { requireConversationMutationAccess } from "./conversation-mutation-access";
import { resolveMessageBotTargetIds } from "./message-bot-targets";
import {
  canonicalizeMessageBody,
  messageBodyHasText,
  storedPartsSignature,
  type CanonicalMessageBody,
  type MessageBody,
} from "./message-parts";
import { inputPartsSignature } from "@thechat/shared";
import { messageReactionsByMessageIds } from "./message-reactions";
import { recordMessageUnreads } from "./activity";
import {
  mainTimelineCondition,
  recordThreadReply,
  recordThreadReplyUnreads,
  resolveReplyRoot,
  threadSummariesForRows,
  threadSummaryForRoot,
} from "./message-threads";

const messageLog = log.child({ component: "messages" });

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type MessageReadExecutor = Pick<typeof db, "select">;

/** Columns every public message read selects (with the sender joined). */
export const publicMessageColumns = {
  id: messages.id,
  conversationId: messages.conversationId,
  threadId: messages.threadId,
  parentMessageId: messages.parentMessageId,
  alsoSentToConversation: messages.alsoSentToConversation,
  replyCount: messages.replyCount,
  lastReplyAt: messages.lastReplyAt,
  senderId: messages.senderId,
  content: messages.content,
  contentFormat: messages.contentFormat,
  parts: messages.parts,
  interim: messages.interim,
  createdAt: messages.createdAt,
  senderName: users.name,
  senderType: users.type,
};

type PublicMessageRow = {
  id: string;
  conversationId: string;
  threadId: string | null;
  parentMessageId?: string | null;
  alsoSentToConversation?: boolean | null;
  replyCount?: number | null;
  lastReplyAt?: Date | null;
  senderId: string;
  senderName: string;
  senderType: "human" | "bot";
  content: string;
  contentFormat?: typeof messages.$inferSelect.contentFormat;
  parts: typeof messages.$inferSelect.parts;
  interim?: boolean;
  createdAt: Date;
};

/** Attachments, reactions and reply summaries for rows, as public messages. */
export async function hydrateMessages(
  rows: PublicMessageRow[],
  viewerId: string,
  includeAttachments: boolean,
): Promise<ChatMessage[]> {
  const ids = rows.map((row) => row.id);
  const [attachmentMap, reactionMap, threadMap] = await Promise.all([
    includeAttachments
      ? attachmentsByMessageIds(ids)
      : Promise.resolve(new Map<string, NonNullable<ChatMessage["attachments"]>>()),
    messageReactionsByMessageIds(ids, viewerId),
    threadSummariesForRows(rows),
  ]);
  return rows.map((row) =>
    toChatMessage(
      row,
      attachmentMap.get(row.id) ?? [],
      reactionMap.get(row.id) ?? [],
      threadMap.get(row.id),
    ),
  );
}

export async function getMessages(
  conversationId: string,
  userId: string,
  options?: {
    limit?: number;
    before?: string;
    threadId?: string;
    unthreaded?: boolean;
    includeAttachments?: boolean;
  },
) {
  await requireParticipant(db, conversationId, userId);

  const limit = Math.min(options?.limit || 50, 100);
  // Thread replies live in their thread; only those also sent to the
  // conversation appear in its timeline.
  const conditions = [eq(messages.conversationId, conversationId), mainTimelineCondition()];
  if (options?.threadId) {
    await requireConversationThread(db, conversationId, options.threadId);
    conditions.push(eq(messages.threadId, options.threadId));
  } else if (options?.unthreaded) {
    conditions.push(isNull(messages.threadId));
  }
  if (options?.before) {
    conditions.push(lt(messages.createdAt, new Date(options.before)));
  }

  const rows = await db
    .select(publicMessageColumns)
    .from(messages)
    .innerJoin(users, eq(messages.senderId, users.id))
    .where(and(...conditions))
    .orderBy(desc(messages.createdAt))
    .limit(limit);
  const chronological = rows.reverse();
  const includeAttachments =
    options?.includeAttachments ?? (await canUserAccessAttachments(db, userId));
  return hydrateMessages(chronological, userId, includeAttachments);
}

export async function getTaskMessagePage(
  conversationId: string,
  userId: string,
  threadId: string | null,
  options: { limit?: number; includeAttachments?: boolean } = {},
): Promise<TaskMessagePage> {
  await requireParticipant(db, conversationId, userId);
  if (threadId) await requireConversationThread(db, conversationId, threadId);

  // Capture BEFORE selecting the displayed page. A backdated transaction that
  // commits later is acknowledged only if its message actually reaches the view.
  const unread = await db
    .select({ id: messageUnreads.messageId })
    .from(messageUnreads)
    .innerJoin(messages, eq(messages.id, messageUnreads.messageId))
    .where(and(
      eq(messageUnreads.userId, userId),
      eq(messageUnreads.conversationId, conversationId),
      threadId ? eq(messages.threadId, threadId) : isNull(messages.threadId),
      mainTimelineCondition(),
    ));
  const page = await getMessages(conversationId, userId, {
    ...options,
    threadId: threadId ?? undefined,
    unthreaded: threadId === null,
  });
  return { messages: page, unreadMessageIds: unread.map((row) => row.id) };
}

export async function getMessageByIdForParticipant(
  messageId: string,
  userId: string,
) {
  const [row] = await db
    .select(publicMessageColumns)
    .from(messages)
    .innerJoin(users, eq(messages.senderId, users.id))
    .where(eq(messages.id, messageId))
    .limit(1);
  if (!row) throw new ServiceError("Message not found", 404);
  await requireParticipant(db, row.conversationId, userId);
  const [message] = await hydrateMessages([row], userId, true);
  return message!;
}

export async function sendMessage(
  conversationId: string,
  userId: string,
  userName: string,
  /**
   * Legacy text, or the canonical body of a request: `parts` (mentions by
   * user ID) or legacy `content`, never both.
   */
  input: string | MessageBody,
  options: {
    threadId?: string | null;
    /** Reply in the thread of this message (or of its root, for a reply). */
    parentMessageId?: string | null;
    /** Also show the reply in the conversation's main timeline. */
    alsoSendToConversation?: boolean;
    clientMessageId?: string | null;
    attachmentIds?: string[];
    afterWorkspaceLocked?: () => Promise<void>;
  } = {},
) {
  const body: MessageBody =
    typeof input === "string" ? { format: "legacy-text", content: input } : input;
  const attachmentIds = options.attachmentIds ?? [];
  const config = loadAttachmentConfig();
  if (!messageBodyHasText(body) && attachmentIds.length === 0) {
    throw new ServiceError(
      "Message text or at least one attachment is required",
      400,
    );
  }
  if (attachmentIds.length > config.maxPerMessage) {
    throw new ServiceError(
      `A message can contain at most ${config.maxPerMessage} attachments`,
      400,
    );
  }
  if (new Set(attachmentIds).size !== attachmentIds.length) {
    throw new ServiceError("attachmentIds must be unique", 400);
  }
  const clientMessageId = normalizeClientMessageId(
    options.clientMessageId ?? crypto.randomUUID(),
  );

  return withSpan(
    "message.send",
    {
      "messaging.system": "thechat",
      "messaging.operation": "send",
      "thechat.message.attachment_count": attachmentIds.length,
      "thechat.message.content_format": body.format,
    },
    async (span) => {
      const result = await db.transaction(async (tx) => {
        const participant = await requireConversationMutationAccess(
          tx,
          conversationId,
          userId,
          { afterWorkspaceLocked: options.afterWorkspaceLocked },
        );
        if (participant.senderType === "bot" && attachmentIds.length > 0) {
          const [bot] = await tx
            .select({ attachmentAccess: bots.attachmentAccess })
            .from(bots)
            .where(eq(bots.userId, userId))
            .limit(1);
          if (bot?.attachmentAccess !== true) {
            throw new ServiceError(
              "Attachment access is not enabled for this bot token",
              403,
            );
          }
        }
        // A reply belongs to its root's Hermes task, whatever the client sent.
        const root = options.parentMessageId
          ? await resolveReplyRoot(tx, conversationId, options.parentMessageId)
          : null;
        if (
          root &&
          options.threadId !== undefined &&
          options.threadId !== null &&
          options.threadId !== root.threadId
        ) {
          throw new ServiceError("Reply must stay in its root message's task", 400);
        }
        const threadId = root ? root.threadId : (options.threadId ?? null);
        if (threadId && !root) {
          await requireConversationThread(tx, conversationId, threadId);
        }
        const parentMessageId = root?.id ?? null;
        const alsoSentToConversation = Boolean(root && options.alsoSendToConversation);

        const existing = await findIdempotentMessage(
          tx,
          userId,
          clientMessageId,
        );
        if (existing) {
          await assertIdempotentCommandMatches(tx, existing, {
            conversationId,
            threadId,
            parentMessageId,
            body,
            attachmentIds,
          });
          return {
            message: existing,
            senderType: participant.senderType,
            conversationType: participant.conversationType,
            duplicate: true,
          };
        }

        // Validate every reference against the conversation, resolve labels
        // and derive the readable content, in the send transaction.
        const canonical = await canonicalizeMessageBody(tx, conversationId, body);
        const [inserted] = await tx
          .insert(messages)
          .values({
            conversationId,
            threadId,
            parentMessageId,
            alsoSentToConversation,
            senderId: userId,
            clientMessageId,
            content: canonical.content,
            contentFormat: canonical.contentFormat,
            parts: canonical.parts,
          })
          .onConflictDoNothing({
            target: [messages.senderId, messages.clientMessageId],
          })
          .returning();
        if (!inserted) {
          const raced = await findIdempotentMessage(
            tx,
            userId,
            clientMessageId,
          );
          if (!raced) throw new Error("Failed to resolve idempotent message");
          await assertIdempotentCommandMatches(tx, raced, {
            conversationId,
            threadId,
            parentMessageId,
            body,
            attachmentIds,
          });
          return {
            message: raced,
            senderType: participant.senderType,
            conversationType: participant.conversationType,
            duplicate: true,
          };
        }

        await recordThreadReply(tx, inserted);
        await recordReplyAwareUnreads(tx, inserted);

        await attachReadyAttachments(tx, {
          messageId: inserted.id,
          attachmentIds,
          conversationId,
          uploaderId: userId,
        });

        if (threadId) {
          await tx
            .update(conversationThreads)
            .set({
              lastActivityAt: inserted.createdAt,
              updatedAt: inserted.createdAt,
            })
            .where(eq(conversationThreads.id, threadId));
        }

        const targetBotIds =
          participant.senderType === "bot"
            ? []
            : await resolveMessageBotTargetIds(tx, {
                conversationId: inserted.conversationId,
                content: inserted.content,
                contentFormat: canonical.contentFormat,
                referencedUserIds: referencedIds(canonical),
                senderId: inserted.senderId,
                senderType: participant.senderType,
              });
        const event = createChatMessageSentV1({
          messageId: inserted.id,
          conversationId: inserted.conversationId,
          targetBotIds,
          messageKind:
            participant.senderType === "bot" ? "bot_response" : "user",
          automationDepth: participant.senderType === "bot" ? 1 : 0,
          senderId: inserted.senderId,
          senderType: participant.senderType,
          workspaceId: participant.workspaceId,
          occurredAt: inserted.createdAt,
        });
        await enqueueDomainEvent(tx, event, {
          partitionKey: inserted.conversationId,
        });
        return {
          message: inserted,
          senderType: participant.senderType,
          conversationType: participant.conversationType,
          duplicate: false,
        };
      }).catch((error) => {
        span.setAttribute("thechat.message.outcome", messageFailureOutcome(error));
        throw error;
      });
      if (!result.duplicate) {
        // Child spans inside the callback report only staged transactional
        // work. The enclosing message span is the first observer of commit.
        span.setAttribute("thechat.outbox.outcome", "committed");
        if (attachmentIds.length > 0) {
          span.setAttribute("thechat.attachment.binding_outcome", "committed");
        }
      }

      const attachmentMap = await attachmentsByMessageIds([result.message.id]);
      const reactions = result.duplicate
        ? (await messageReactionsByMessageIds([result.message.id], userId)).get(
            result.message.id,
          ) ?? []
        : [];
      const ownSummary = result.duplicate
        ? (await threadSummariesForRows([result.message])).get(result.message.id)
        : undefined;
      const publicMessage = toChatMessage(
        {
          ...result.message,
          senderName: userName,
          senderType: result.senderType,
        },
        attachmentMap.get(result.message.id) ?? [],
        reactions,
        ownSummary,
      );
      span.setAttribute("thechat.message.idempotent_replay", result.duplicate);
      span.setAttribute(
        "thechat.message.outcome",
        result.duplicate ? "idempotent_replay" : "sent",
      );
      // REST and compatibility WebSocket sends both arrive here. Realtime is
      // emitted only after the message/thread/attachment/outbox transaction.
      if (!result.duplicate) {
        const participants = await db
          .select({
            userId: conversationParticipants.userId,
            userType: users.type,
            attachmentAccess: bots.attachmentAccess,
          })
          .from(conversationParticipants)
          .innerJoin(users, eq(users.id, conversationParticipants.userId))
          .leftJoin(bots, eq(bots.userId, conversationParticipants.userId))
          .where(
            eq(
              conversationParticipants.conversationId,
              publicMessage.conversationId,
            ),
          );
        const hasAttachments = (publicMessage.attachments?.length ?? 0) > 0;
        const scopedRecipients = participants.filter(
          (participant) =>
            !hasAttachments ||
            participant.userType !== "bot" ||
            participant.attachmentAccess === true,
        );
        const redactedRecipients = participants.filter(
          (participant) =>
            hasAttachments &&
            participant.userType === "bot" &&
            participant.attachmentAccess !== true,
        );
        const rootThread = publicMessage.parentMessageId
          ? await threadSummaryForRoot(publicMessage.parentMessageId)
          : null;
        const realtimeEvent: WsServerEvent = {
          type: "new_message",
          message: publicMessage,
          conversationType: result.conversationType,
          clientMessageId,
          ...(rootThread ? { rootThread } : {}),
        };
        try {
          await Promise.all([
            publishWsEventToUsers(
              scopedRecipients.map((participant) => participant.userId),
              realtimeEvent,
            ),
            redactedRecipients.length > 0
              ? publishWsEventToUsers(
                  redactedRecipients.map((participant) => participant.userId),
                  {
                    ...realtimeEvent,
                    message: { ...publicMessage, attachments: [] },
                  },
                )
              : Promise.resolve(),
          ]);
        } catch (error) {
          // The database transaction and durable domain event have already
          // committed. A transient realtime fanout failure must not turn a
          // successful send into an ambiguous client failure.
          messageLog.warn(
            {
              errorType: safeErrorType(error),
              conversationId: publicMessage.conversationId,
              messageId: publicMessage.id,
            },
            "message.realtime_publish_failed",
          );
        }
      }

      return publicMessage;
    },
  );
}

function messageFailureOutcome(error: unknown) {
  if (!(error instanceof ServiceError)) return "failed";
  if (error.status === 409) return "idempotency_conflict";
  if (error.status === 403) return "forbidden";
  if (error.status === 404) return "not_found";
  if (error.status === 400) return "invalid";
  return "rejected";
}

function safeErrorType(error: unknown) {
  return error instanceof Error &&
    /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(error.name)
    ? error.name
    : "Error";
}

export async function attachReadyAttachments(
  tx: DbTransaction,
  input: {
    messageId: string;
    attachmentIds: string[];
    conversationId: string;
    uploaderId: string;
  },
) {
  if (input.attachmentIds.length === 0) return [];
  return withSpan(
    "attachment.bind",
    {
      "thechat.attachment.binding_count": input.attachmentIds.length,
      "thechat.attachment.from_status": "ready",
      "thechat.attachment.to_status": "attached",
    },
    async (span) => {
      const rows = await tx
        .select()
        .from(attachments)
        .where(inArray(attachments.id, input.attachmentIds))
        .for("update");
      const byId = new Map(rows.map((row) => [row.id, row]));
      const ordered = input.attachmentIds.map((id) => byId.get(id));
      if (
        ordered.some(
          (row) =>
            !row ||
            row.conversationId !== input.conversationId ||
            row.uploaderId !== input.uploaderId ||
            row.status !== "ready",
        )
      ) {
        span.setAttribute("thechat.attachment.binding_outcome", "rejected");
        span.setAttribute(
          "thechat.attachment.failure_reason",
          "not_ready_or_owned",
        );
        throw new ServiceError(
          "Every attachment must be ready, unused, uploaded by the sender, and belong to this conversation",
          409,
        );
      }

      await tx.insert(messageAttachments).values(
        input.attachmentIds.map((attachmentId, position) => ({
          messageId: input.messageId,
          attachmentId,
          position,
        })),
      );
      const now = new Date();
      const updated = await tx
        .update(attachments)
        .set({ status: "attached", attachedAt: now, updatedAt: now })
        .where(
          and(
            inArray(attachments.id, input.attachmentIds),
            eq(attachments.status, "ready"),
          ),
        )
        .returning({ id: attachments.id });
      if (updated.length !== input.attachmentIds.length) {
        span.setAttribute("thechat.attachment.binding_outcome", "conflict");
        throw new ServiceError(
          "Attachment binding conflicted with another request",
          409,
        );
      }
      span.setAttribute("thechat.attachment.binding_outcome", "staged");
      return ordered;
    },
  );
}

export async function canUserAccessAttachments(
  executor: MessageReadExecutor,
  userId: string,
) {
  const [actor] = await executor
    .select({
      userType: users.type,
      attachmentAccess: bots.attachmentAccess,
    })
    .from(users)
    .leftJoin(bots, eq(bots.userId, users.id))
    .where(eq(users.id, userId))
    .limit(1);
  return Boolean(
    actor && (actor.userType !== "bot" || actor.attachmentAccess === true),
  );
}

/** Referenced user IDs of a canonical body, in first-occurrence order. */
function referencedIds(canonical: CanonicalMessageBody) {
  return canonical.references.map((reference) => reference.userId);
}

/**
 * Whether a stored message was created by the same authoring command. A
 * parts-v1 command matches only a parts-v1 row with the same text and the
 * same reference IDs in order: the same visible "@Koda" pointing at another
 * user is a different command.
 */
function sameMessageBody(
  existing: Pick<typeof messages.$inferSelect, "content" | "contentFormat" | "parts">,
  body: MessageBody,
) {
  if (body.format === "parts-v1") {
    return storedPartsSignature(existing) === inputPartsSignature(body.parts);
  }
  return existing.contentFormat !== "parts-v1" && existing.content === body.content.trim();
}

export async function assertIdempotentCommandMatches(
  tx: MessageReadExecutor,
  existing: typeof messages.$inferSelect,
  command: {
    conversationId: string;
    threadId: string | null;
    parentMessageId?: string | null;
    /** Legacy text or the request's canonical body. */
    body: MessageBody | string;
    attachmentIds: string[];
  },
) {
  const body: MessageBody =
    typeof command.body === "string"
      ? { format: "legacy-text", content: command.body }
      : command.body;
  const links = await tx
    .select({ attachmentId: messageAttachments.attachmentId })
    .from(messageAttachments)
    .where(eq(messageAttachments.messageId, existing.id))
    .orderBy(asc(messageAttachments.position));
  const existingAttachmentIds = links.map((link) => link.attachmentId);
  if (
    existing.conversationId !== command.conversationId ||
    existing.threadId !== command.threadId ||
    (command.parentMessageId !== undefined &&
      (existing.parentMessageId ?? null) !== command.parentMessageId) ||
    !sameMessageBody(existing, body) ||
    existingAttachmentIds.length !== command.attachmentIds.length ||
    existingAttachmentIds.some(
      (id, index) => id !== command.attachmentIds[index],
    )
  ) {
    throw new ServiceError(
      "clientMessageId was already used for a different message command",
      409,
    );
  }
}

export async function findIdempotentMessage(
  tx: MessageReadExecutor,
  senderId: string,
  clientMessageId: string,
) {
  const [existing] = await tx
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.senderId, senderId),
        eq(messages.clientMessageId, clientMessageId),
      ),
    )
    .limit(1);
  return existing ?? null;
}

async function requireParticipant(
  executor: typeof db | DbTransaction,
  conversationId: string,
  userId: string,
  includeContext = false,
) {
  const [participant] = await executor
    .select({
      userId: conversationParticipants.userId,
      senderType: users.type,
      workspaceId: conversations.workspaceId,
      conversationType: conversations.type,
      workspaceMemberUserId: workspaceMembers.userId,
    })
    .from(conversationParticipants)
    .innerJoin(
      conversations,
      eq(conversationParticipants.conversationId, conversations.id),
    )
    .innerJoin(users, eq(conversationParticipants.userId, users.id))
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
    throw new ServiceError(
      "You are not a participant of this conversation",
      403,
    );
  }
  return includeContext ? participant : participant;
}

async function requireConversationThread(
  executor: typeof db | DbTransaction,
  conversationId: string,
  threadId: string,
) {
  const [thread] = await executor
    .select({ id: conversationThreads.id })
    .from(conversationThreads)
    .where(
      and(
        eq(conversationThreads.id, threadId),
        eq(conversationThreads.conversationId, conversationId),
      ),
    )
    .limit(1);
  if (!thread) {
    throw new ServiceError("Thread does not belong to this conversation", 400);
  }
}

function normalizeClientMessageId(value: string) {
  const normalized = value
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    .trim();
  if (!normalized || normalized.length > 255) {
    throw new ServiceError(
      "clientMessageId must be between 1 and 255 characters",
      400,
    );
  }
  return normalized;
}

export function toChatMessage(
  row: PublicMessageRow,
  messageAttachments: ChatMessage["attachments"],
  reactions: NonNullable<ChatMessage["reactions"]>,
  thread?: MessageThreadSummary,
): ChatMessage {
  return {
    id: row.id,
    conversationId: row.conversationId,
    threadId: row.threadId,
    senderId: row.senderId,
    senderName: row.senderName,
    senderType: row.senderType,
    content: row.content,
    ...(row.contentFormat === "parts-v1" ? { contentFormat: "parts-v1" as const } : {}),
    parts: row.parts ?? null,
    attachments: messageAttachments,
    reactions,
    ...(row.interim ? { interim: true as const } : {}),
    ...(row.parentMessageId ? { parentMessageId: row.parentMessageId } : {}),
    ...(row.parentMessageId && row.alsoSentToConversation
      ? { alsoSentToConversation: true as const }
      : {}),
    ...(thread ? { thread } : {}),
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Unread rows for a new message: everyone for the main timeline, only the
 * thread's followers for a reply that stays in its thread.
 */
export async function recordReplyAwareUnreads(
  tx: DbTransaction,
  message: {
    id: string;
    conversationId: string;
    senderId: string;
    parentMessageId: string | null;
    alsoSentToConversation: boolean;
  },
) {
  if (!message.parentMessageId) {
    await recordMessageUnreads(tx, message);
    return;
  }
  await recordThreadReplyUnreads(tx, {
    ...message,
    parentMessageId: message.parentMessageId,
  });
  if (message.alsoSentToConversation) await recordMessageUnreads(tx, message);
}

// -- Reply threads --------------------------------------------------------

const THREAD_PAGE_SIZE = 50;

/** One reply thread: its root, replies (newest page) and follow state. */
export async function getThreadPage(
  conversationId: string,
  rootMessageId: string,
  userId: string,
  options: { limit?: number; before?: string; includeAttachments?: boolean } = {},
): Promise<MessageThreadPage> {
  await requireParticipant(db, conversationId, userId);
  const [rootRow] = await db
    .select(publicMessageColumns)
    .from(messages)
    .innerJoin(users, eq(messages.senderId, users.id))
    .where(and(eq(messages.id, rootMessageId), eq(messages.conversationId, conversationId)))
    .limit(1);
  if (!rootRow) throw new ServiceError("Message not found", 404);
  if (rootRow.parentMessageId) {
    throw new ServiceError("Open the thread of the root message", 400);
  }

  const limit = Math.min(Math.max(options.limit ?? THREAD_PAGE_SIZE, 1), 100);
  // Capture before reading the page (see getTaskMessagePage).
  const unread = await db
    .select({ id: messageUnreads.messageId })
    .from(messageUnreads)
    .innerJoin(messages, eq(messages.id, messageUnreads.messageId))
    .where(
      and(
        eq(messageUnreads.userId, userId),
        eq(messageUnreads.conversationId, conversationId),
        eq(messages.parentMessageId, rootMessageId),
      ),
    );
  const replyRows = await db
    .select(publicMessageColumns)
    .from(messages)
    .innerJoin(users, eq(messages.senderId, users.id))
    .where(
      and(
        eq(messages.parentMessageId, rootMessageId),
        options.before ? lt(messages.createdAt, new Date(options.before)) : undefined,
      ),
    )
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(limit + 1);
  const hasOlder = replyRows.length > limit;
  const chronological = replyRows.slice(0, limit).reverse();
  const includeAttachments =
    options.includeAttachments ?? (await canUserAccessAttachments(db, userId));
  const [root, ...replies] = await hydrateMessages(
    [rootRow, ...chronological],
    userId,
    includeAttachments,
  );
  const [follow] = await db
    .select({ following: messageThreadFollowers.following })
    .from(messageThreadFollowers)
    .where(
      and(
        eq(messageThreadFollowers.rootMessageId, rootMessageId),
        eq(messageThreadFollowers.userId, userId),
      ),
    )
    .limit(1);
  return {
    root: root!,
    replies,
    hasOlder,
    following: follow?.following ?? false,
    unreadMessageIds: unread.map((row) => row.id),
  };
}

/** Follow or unfollow a reply thread. Unfollowing also clears its unread replies. */
export async function setThreadFollowing(
  conversationId: string,
  rootMessageId: string,
  userId: string,
  following: boolean,
) {
  await requireParticipant(db, conversationId, userId);
  const [root] = await db
    .select({ id: messages.id, parentMessageId: messages.parentMessageId })
    .from(messages)
    .where(and(eq(messages.id, rootMessageId), eq(messages.conversationId, conversationId)))
    .limit(1);
  if (!root) throw new ServiceError("Message not found", 404);
  if (root.parentMessageId) throw new ServiceError("Follow the root message's thread", 400);
  await db.transaction(async (tx) => {
    await tx
      .insert(messageThreadFollowers)
      .values({ rootMessageId, conversationId, userId, following })
      .onConflictDoUpdate({
        target: [messageThreadFollowers.rootMessageId, messageThreadFollowers.userId],
        set: { following, updatedAt: new Date() },
      });
    if (!following) {
      await tx.delete(messageUnreads).where(
        and(
          eq(messageUnreads.userId, userId),
          eq(messageUnreads.conversationId, conversationId),
          inArray(
            messageUnreads.messageId,
            tx
              .select({ id: messages.id })
              .from(messages)
              .where(
                and(
                  eq(messages.parentMessageId, rootMessageId),
                  eq(messages.alsoSentToConversation, false),
                ),
              ),
          ),
        ),
      );
    }
  });
  return { rootMessageId, following };
}

const FOLLOWED_THREADS_PAGE_SIZE = 20;
const FOLLOWED_THREAD_PREVIEW_REPLIES = 3;

/**
 * Threads the user follows that have replies, most recent reply first. Like
 * Slack's Threads view: each with its root, newest replies and unread count.
 */
export async function listFollowedThreads(
  userId: string,
  options: { workspaceId?: string | null; before?: string | null; limit?: number } = {},
): Promise<FollowedThreadsPage> {
  const limit = Math.min(Math.max(options.limit ?? FOLLOWED_THREADS_PAGE_SIZE, 1), 50);
  const rootRows = await db
    .select({
      ...publicMessageColumns,
      conversationType: conversations.type,
      conversationName: conversations.name,
      conversationTitle: conversations.title,
      workspaceId: workspaces.id,
      workspaceName: workspaces.name,
    })
    .from(messageThreadFollowers)
    .innerJoin(messages, eq(messages.id, messageThreadFollowers.rootMessageId))
    .innerJoin(users, eq(users.id, messages.senderId))
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
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
        eq(messageThreadFollowers.userId, userId),
        eq(messageThreadFollowers.following, true),
        gt(messages.replyCount, 0),
        options.workspaceId ? eq(conversations.workspaceId, options.workspaceId) : undefined,
        options.before ? lt(messages.lastReplyAt, new Date(options.before)) : undefined,
      ),
    )
    .orderBy(desc(messages.lastReplyAt), desc(messages.id))
    .limit(limit + 1);
  const page = rootRows.slice(0, limit);
  if (page.length === 0) return { items: [], nextCursor: null };
  const rootIds = page.map((row) => row.id);

  // The newest replies of each thread, via a window over the reply index.
  const ranked = db
    .select({
      id: messages.id,
      rank: sql<number>`row_number() over (partition by ${messages.parentMessageId} order by ${messages.createdAt} desc, ${messages.id} desc)`.as("rank"),
    })
    .from(messages)
    .where(inArray(messages.parentMessageId, rootIds))
    .as("ranked");
  const replyRows = await db
    .select(publicMessageColumns)
    .from(messages)
    .innerJoin(ranked, eq(ranked.id, messages.id))
    .innerJoin(users, eq(users.id, messages.senderId))
    .where(sql`${ranked.rank} <= ${FOLLOWED_THREAD_PREVIEW_REPLIES}`)
    .orderBy(asc(messages.createdAt), asc(messages.id));

  const unreadRows = await db
    .select({
      rootId: messages.parentMessageId,
      count: sql<number>`count(*)::int`,
    })
    .from(messageUnreads)
    .innerJoin(messages, eq(messages.id, messageUnreads.messageId))
    .where(
      and(
        eq(messageUnreads.userId, userId),
        inArray(messages.parentMessageId, rootIds),
      ),
    )
    .groupBy(messages.parentMessageId);
  const unreadByRoot = new Map(unreadRows.map((row) => [row.rootId, Number(row.count)]));

  // Direct conversations are named after the other person.
  const directIds = [...new Set(page.filter((row) => row.conversationType === "direct").map((row) => row.conversationId))];
  const others = directIds.length
    ? await db
        .select({ conversationId: conversationParticipants.conversationId, name: users.name })
        .from(conversationParticipants)
        .innerJoin(users, eq(users.id, conversationParticipants.userId))
        .where(
          and(
            inArray(conversationParticipants.conversationId, directIds),
            ne(conversationParticipants.userId, userId),
          ),
        )
    : [];
  const otherName = new Map(others.map((row) => [row.conversationId, row.name]));

  const includeAttachments = await canUserAccessAttachments(db, userId);
  const hydrated = await hydrateMessages([...page, ...replyRows], userId, includeAttachments);
  const byId = new Map(hydrated.map((message) => [message.id, message]));
  const repliesByRoot = new Map<string, ChatMessage[]>();
  for (const row of replyRows) {
    const list = repliesByRoot.get(row.parentMessageId!) ?? [];
    list.push(byId.get(row.id)!);
    repliesByRoot.set(row.parentMessageId!, list);
  }

  const items: FollowedThread[] = page.map((row) => ({
    conversationId: row.conversationId,
    conversationType: row.conversationType,
    conversationName:
      row.conversationType === "direct"
        ? (otherName.get(row.conversationId) ?? "Direct message")
        : (row.conversationTitle ?? row.conversationName ?? "channel"),
    workspaceId: row.workspaceId,
    workspaceName: row.workspaceName,
    root: byId.get(row.id)!,
    latestReplies: repliesByRoot.get(row.id) ?? [],
    replyCount: row.replyCount ?? 0,
    unreadCount: unreadByRoot.get(row.id) ?? 0,
    lastReplyAt: (row.lastReplyAt ?? row.createdAt).toISOString(),
  }));
  const last = page[page.length - 1]!;
  return {
    items,
    nextCursor: rootRows.length > limit ? (last.lastReplyAt ?? last.createdAt).toISOString() : null,
  };
}
