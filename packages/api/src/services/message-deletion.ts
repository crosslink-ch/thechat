import { and, eq, inArray } from "drizzle-orm";
import { pendingChatJobs } from "../async/queue";
import {
  ATTACHMENT_DELETION_REQUESTED,
  createAttachmentLifecycleEvent,
} from "../attachments/events";
import { db } from "../db";
import {
  attachments,
  botInvocations,
  messageAttachments,
  messages,
} from "../db/schema";
import { enqueueDomainEvent } from "../events/outbox";
import { withSpan } from "../observability";
import {
  botInvocationIsActive,
  currentHermesDispatchTimeoutCutoff,
} from "./bot-runtime";
import { requireConversationMutationAccess } from "./conversation-mutation-access";
import { ServiceError } from "./errors";
import { publishToConversation } from "./task-project-records";

/**
 * Permanently deletes a message for everyone. Only its author may do this.
 * The row is removed, with no "message deleted" placeholder: reactions, unread
 * markers, attachment links and the bot runs it triggered go with it, so it
 * also leaves search, unread counts and Activity. Attached files move to
 * `deleting` and the worker removes them from object storage.
 */
export async function deleteMessage(
  conversationId: string,
  messageId: string,
  userId: string,
  options: { afterWorkspaceLocked?: () => Promise<void> } = {},
) {
  const hermesDispatchCutoff = currentHermesDispatchTimeoutCutoff();

  return withSpan(
    "message.delete",
    { "messaging.system": "thechat", "messaging.operation": "delete" },
    async (span) => {
      const deleted = await db
        .transaction(async (tx) => {
          await requireConversationMutationAccess(
            tx,
            conversationId,
            userId,
            options,
          );

          const [message] = await tx
            .select({
              id: messages.id,
              senderId: messages.senderId,
              threadId: messages.threadId,
            })
            .from(messages)
            .where(
              and(
                eq(messages.id, messageId),
                eq(messages.conversationId, conversationId),
              ),
            )
            .for("update")
            .limit(1);
          if (!message) throw new ServiceError("Message not found", 404);
          if (message.senderId !== userId) {
            throw new ServiceError(
              "Only the author can delete this message",
              403,
            );
          }

          // Same rule as task and channel deletion: a bot still working on
          // this message, or about to receive it, would answer into nothing.
          const [activeInvocation] = await tx
            .select({ id: botInvocations.id })
            .from(botInvocations)
            .where(
              and(
                eq(botInvocations.triggerMessageId, message.id),
                botInvocationIsActive(hermesDispatchCutoff),
              ),
            )
            .limit(1);
          const [pendingTargetedEvent] = await pendingChatJobs(
            tx,
            conversationId,
            { messageId: message.id },
          );
          if (activeInvocation || pendingTargetedEvent) {
            throw new ServiceError(
              "Wait for the bot to finish responding to this message before deleting it",
              409,
            );
          }

          // Attachment rows own the private object-store coordinates, so they
          // stay until the worker has removed the stored files.
          const now = new Date();
          const doomedAttachments = await tx
            .update(attachments)
            .set({ status: "deleting", deletingAt: now, updatedAt: now })
            .where(
              and(
                eq(attachments.status, "attached"),
                inArray(
                  attachments.id,
                  tx
                    .select({ id: messageAttachments.attachmentId })
                    .from(messageAttachments)
                    .where(eq(messageAttachments.messageId, message.id)),
                ),
              ),
            )
            .returning({ id: attachments.id });
          for (const attachment of doomedAttachments) {
            await enqueueDomainEvent(
              tx,
              createAttachmentLifecycleEvent(
                ATTACHMENT_DELETION_REQUESTED,
                attachment.id,
                userId,
              ),
              { partitionKey: `attachment:${attachment.id}` },
            );
          }

          await tx.delete(messages).where(eq(messages.id, message.id));

          return {
            threadId: message.threadId,
            deletedAttachmentCount: doomedAttachments.length,
          };
        })
        .catch((error) => {
          span.setAttribute(
            "thechat.message.outcome",
            error instanceof ServiceError
              ? `rejected_${error.status}`
              : "failed",
          );
          throw error;
        });

      span.setAttribute("thechat.message.outcome", "deleted");
      span.setAttribute(
        "thechat.message.attachment_count",
        deleted.deletedAttachmentCount,
      );

      await publishToConversation(conversationId, {
        type: "message_deleted",
        conversationId,
        messageId,
        threadId: deleted.threadId,
      });

      return { ok: true as const, conversationId, messageId, ...deleted };
    },
  );
}
