import { z } from "zod";
import {
  parseDomainEventEnvelope,
} from "../events/envelope";

export const ATTACHMENT_VALIDATION_REQUESTED = "attachment.validation_requested";
export const ATTACHMENT_DELETION_REQUESTED = "attachment.deletion_requested";
export const ATTACHMENT_EVENT_VERSION = 1;

const attachmentEventSchema = z
  .object({
    id: z.string().uuid(),
    type: z.enum([
      ATTACHMENT_VALIDATION_REQUESTED,
      ATTACHMENT_DELETION_REQUESTED,
    ]),
    version: z.literal(ATTACHMENT_EVENT_VERSION),
    aggregate: z.object({
      type: z.literal("attachment"),
      id: z.string().uuid(),
    }),
    occurredAt: z.string().datetime(),
    payload: z.object({ attachmentId: z.string().uuid() }),
  })
  .passthrough()
  .superRefine((event, context) => {
    if (event.aggregate.id !== event.payload.attachmentId) {
      context.addIssue({
        code: "custom",
        path: ["payload", "attachmentId"],
        message: "payload.attachmentId must match aggregate.id",
      });
    }
  });

export type AttachmentLifecycleEvent = z.infer<typeof attachmentEventSchema>;

export function createAttachmentLifecycleEvent(
  type: AttachmentLifecycleEvent["type"],
  attachmentId: string,
  actorId: string,
): AttachmentLifecycleEvent {
  return parseAttachmentLifecycleEvent({
    id: crypto.randomUUID(),
    type,
    version: ATTACHMENT_EVENT_VERSION,
    aggregate: { type: "attachment", id: attachmentId },
    actor: { type: "user", id: actorId },
    occurredAt: new Date().toISOString(),
    payload: { attachmentId },
  });
}

export function parseAttachmentLifecycleEvent(
  value: unknown,
): AttachmentLifecycleEvent {
  const envelope = parseDomainEventEnvelope(value);
  return attachmentEventSchema.parse(envelope) as AttachmentLifecycleEvent;
}
