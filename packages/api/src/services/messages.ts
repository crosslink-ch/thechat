import crypto from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  lt,
} from "drizzle-orm";
import type { ChatMessage, WsServerEvent } from "@thechat/shared";
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
  users,
} from "../db/schema";
import { createChatMessageSentV1 } from "../events/envelope";
import { enqueueDomainEvent } from "../events/outbox";
import { log } from "../logging";
import { withSpan } from "../observability";
import { publishWsEventToUsers } from "../realtime";
import { ServiceError } from "./errors";
import { resolveMessageBotTargetIds } from "./message-bot-targets";

const messageLog = log.child({ component: "messages" });

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type MessageReadExecutor = Pick<typeof db, "select">;

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
  const conditions = [eq(messages.conversationId, conversationId)];
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
    .select({
      id: messages.id,
      conversationId: messages.conversationId,
      threadId: messages.threadId,
      senderId: messages.senderId,
      content: messages.content,
      parts: messages.parts,
      createdAt: messages.createdAt,
      senderName: users.name,
      senderType: users.type,
    })
    .from(messages)
    .innerJoin(users, eq(messages.senderId, users.id))
    .where(and(...conditions))
    .orderBy(desc(messages.createdAt))
    .limit(limit);
  const chronological = rows.reverse();
  const includeAttachments =
    options?.includeAttachments ??
    (await canUserAccessAttachments(db, userId));
  const attachmentMap = includeAttachments
    ? await attachmentsByMessageIds(rows.map((row) => row.id))
    : new Map<string, NonNullable<ChatMessage["attachments"]>>();

  return chronological.map((row) =>
    toChatMessage(row, attachmentMap.get(row.id) ?? []),
  );
}

export async function getMessageByIdForParticipant(
  messageId: string,
  userId: string,
) {
  const [row] = await db
    .select({
      id: messages.id,
      conversationId: messages.conversationId,
      threadId: messages.threadId,
      senderId: messages.senderId,
      content: messages.content,
      parts: messages.parts,
      createdAt: messages.createdAt,
      senderName: users.name,
      senderType: users.type,
    })
    .from(messages)
    .innerJoin(users, eq(messages.senderId, users.id))
    .where(eq(messages.id, messageId))
    .limit(1);
  if (!row) throw new ServiceError("Message not found", 404);
  await requireParticipant(db, row.conversationId, userId);
  const attachmentMap = await attachmentsByMessageIds([row.id]);
  return toChatMessage(row, attachmentMap.get(row.id) ?? []);
}

export async function sendMessage(
  conversationId: string,
  userId: string,
  userName: string,
  content: string,
  options: {
    threadId?: string | null;
    clientMessageId?: string | null;
    attachmentIds?: string[];
  } = {},
) {
  const normalizedContent = content.trim();
  const attachmentIds = options.attachmentIds ?? [];
  const config = loadAttachmentConfig();
  if (!normalizedContent && attachmentIds.length === 0) {
    throw new ServiceError("Message text or at least one attachment is required", 400);
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
      "thechat.conversation_id": conversationId,
      "thechat.user_id": userId,
      "thechat.message.attachment_count": attachmentIds.length,
    },
    async (span) => {
      const result = await db.transaction(async (tx) => {
        const participant = await requireParticipant(
          tx,
          conversationId,
          userId,
          true,
        );
        if (participant.senderType === "bot" && attachmentIds.length > 0) {
          if (attachmentIds.length > config.botMaxPerMessage) {
            throw new ServiceError(
              `A bot message can contain at most ${config.botMaxPerMessage} attachments`,
              400,
            );
          }
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
        const threadId = options.threadId ?? null;
        if (threadId) {
          await requireConversationThread(tx, conversationId, threadId);
        }

        const existing = await findIdempotentMessage(
          tx,
          userId,
          clientMessageId,
        );
        if (existing) {
          await assertIdempotentCommandMatches(tx, existing, {
            conversationId,
            threadId,
            content: normalizedContent,
            attachmentIds,
          });
          return {
            message: existing,
            senderType: participant.senderType,
            conversationType: participant.conversationType,
            duplicate: true,
          };
        }

        const [inserted] = await tx
          .insert(messages)
          .values({
            conversationId,
            threadId,
            senderId: userId,
            clientMessageId,
            content: normalizedContent,
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
            content: normalizedContent,
            attachmentIds,
          });
          return {
            message: raced,
            senderType: participant.senderType,
            conversationType: participant.conversationType,
            duplicate: true,
          };
        }

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
      });

      const attachmentMap = await attachmentsByMessageIds([result.message.id]);
      const publicMessage = toChatMessage(
        {
          ...result.message,
          senderName: userName,
          senderType: result.senderType,
        },
        attachmentMap.get(result.message.id) ?? [],
      );
      span.setAttribute("thechat.message_id", result.message.id);
      span.setAttribute("thechat.message.idempotent_replay", result.duplicate);
      if (result.message.threadId) {
        span.setAttribute("thechat.thread_id", result.message.threadId);
      }

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
        const realtimeEvent: WsServerEvent = {
          type: "new_message",
          message: publicMessage,
          conversationType: result.conversationType,
          clientMessageId,
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
              err: error,
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
  await tx
    .update(attachments)
    .set({ status: "attached", attachedAt: now, updatedAt: now })
    .where(
      and(
        inArray(attachments.id, input.attachmentIds),
        eq(attachments.status, "ready"),
      ),
    );
  return ordered;
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
    actor &&
      (actor.userType !== "bot" || actor.attachmentAccess === true),
  );
}

export async function assertIdempotentCommandMatches(
  tx: MessageReadExecutor,
  existing: typeof messages.$inferSelect,
  command: {
    conversationId: string;
    threadId: string | null;
    content: string;
    attachmentIds: string[];
  },
) {
  const links = await tx
    .select({ attachmentId: messageAttachments.attachmentId })
    .from(messageAttachments)
    .where(eq(messageAttachments.messageId, existing.id))
    .orderBy(asc(messageAttachments.position));
  const existingAttachmentIds = links.map((link) => link.attachmentId);
  if (
    existing.conversationId !== command.conversationId ||
    existing.threadId !== command.threadId ||
    existing.content !== command.content ||
    existingAttachmentIds.length !== command.attachmentIds.length ||
    existingAttachmentIds.some((id, index) => id !== command.attachmentIds[index])
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
    })
    .from(conversationParticipants)
    .innerJoin(
      conversations,
      eq(conversationParticipants.conversationId, conversations.id),
    )
    .innerJoin(users, eq(conversationParticipants.userId, users.id))
    .where(
      and(
        eq(conversationParticipants.conversationId, conversationId),
        eq(conversationParticipants.userId, userId),
      ),
    )
    .limit(1);
  if (!participant) {
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
    throw new ServiceError("clientMessageId must be between 1 and 255 characters", 400);
  }
  return normalized;
}

function toChatMessage(
  row: {
    id: string;
    conversationId: string;
    threadId: string | null;
    senderId: string;
    senderName: string;
    senderType: "human" | "bot";
    content: string;
    parts: typeof messages.$inferSelect.parts;
    createdAt: Date;
  },
  messageAttachments: ChatMessage["attachments"],
): ChatMessage {
  return {
    id: row.id,
    conversationId: row.conversationId,
    threadId: row.threadId,
    senderId: row.senderId,
    senderName: row.senderName,
    senderType: row.senderType,
    content: row.content,
    parts: row.parts ?? null,
    attachments: messageAttachments,
    createdAt: row.createdAt.toISOString(),
  };
}
