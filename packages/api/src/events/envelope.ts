import crypto from "crypto";
import { z } from "zod";

const nonEmptyString = z.string().trim().min(1);

export const domainEventEnvelopeSchema = z.object({
  id: z.string().uuid(),
  type: nonEmptyString,
  version: z.number().int().positive(),
  aggregate: z.object({
    type: nonEmptyString,
    id: nonEmptyString,
  }),
  actor: z
    .object({
      type: nonEmptyString,
      id: nonEmptyString,
    })
    .optional(),
  tenant: z
    .object({
      workspaceId: nonEmptyString,
    })
    .optional(),
  correlationId: nonEmptyString.optional(),
  causationId: nonEmptyString.optional(),
  occurredAt: z.string().datetime({ offset: true }),
  payload: z.record(z.string(), z.unknown()),
});

export type DomainEventEnvelope = z.infer<typeof domainEventEnvelopeSchema>;

export const CHAT_MESSAGE_SENT_EVENT_TYPE = "chat.message.sent";
export const CHAT_MESSAGE_SENT_EVENT_VERSION = 1;

export const chatMessageSentV1Schema = domainEventEnvelopeSchema.extend({
  type: z.literal(CHAT_MESSAGE_SENT_EVENT_TYPE),
  version: z.literal(CHAT_MESSAGE_SENT_EVENT_VERSION),
  aggregate: z.object({
    type: z.literal("message"),
    id: z.string().uuid(),
  }),
  payload: z.object({
    messageId: z.string().uuid(),
  }),
}).superRefine((event, context) => {
  if (event.aggregate.id !== event.payload.messageId) {
    context.addIssue({
      code: "custom",
      path: ["payload", "messageId"],
      message: "messageId must match aggregate.id",
    });
  }
});

export type ChatMessageSentV1 = z.infer<typeof chatMessageSentV1Schema>;

export function parseDomainEventEnvelope(value: unknown): DomainEventEnvelope {
  return domainEventEnvelopeSchema.parse(value);
}

export function parseChatMessageSentV1(value: unknown): ChatMessageSentV1 {
  return chatMessageSentV1Schema.parse(value);
}

export function createChatMessageSentV1(input: {
  messageId: string;
  senderId: string;
  senderType: "human" | "bot";
  workspaceId?: string | null;
  correlationId?: string;
  causationId?: string;
  occurredAt?: Date;
}): ChatMessageSentV1 {
  return chatMessageSentV1Schema.parse({
    id: crypto.randomUUID(),
    type: CHAT_MESSAGE_SENT_EVENT_TYPE,
    version: CHAT_MESSAGE_SENT_EVENT_VERSION,
    aggregate: { type: "message", id: input.messageId },
    actor: { type: input.senderType, id: input.senderId },
    ...(input.workspaceId
      ? { tenant: { workspaceId: input.workspaceId } }
      : {}),
    correlationId: input.correlationId ?? input.messageId,
    ...(input.causationId ? { causationId: input.causationId } : {}),
    occurredAt: (input.occurredAt ?? new Date()).toISOString(),
    payload: { messageId: input.messageId },
  });
}
