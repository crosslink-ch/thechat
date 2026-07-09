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
export const MAX_BOT_AUTOMATION_DEPTH = 8;

export const chatMessageKindSchema = z.enum([
  "user",
  "bot_response",
  "system_failure",
]);

export const chatMessageSentV1Schema = domainEventEnvelopeSchema.extend({
  type: z.literal(CHAT_MESSAGE_SENT_EVENT_TYPE),
  version: z.literal(CHAT_MESSAGE_SENT_EVENT_VERSION),
  aggregate: z.object({
    type: z.literal("message"),
    id: z.string().uuid(),
  }),
  payload: z.object({
    messageId: z.string().uuid(),
    conversationId: z.string().uuid(),
    targetBotIds: z.array(z.string().uuid()),
    messageKind: chatMessageKindSchema,
    automationDepth: z.number().int().nonnegative().max(100),
  }),
}).superRefine((event, ctx) => {
  if (event.aggregate.id !== event.payload.messageId) {
    ctx.addIssue({
      code: "custom",
      path: ["payload", "messageId"],
      message: "payload.messageId must match aggregate.id",
    });
  }
  const expectedActorType =
    event.payload.messageKind === "user" ? "human" : "bot";
  if (event.actor?.type !== expectedActorType) {
    ctx.addIssue({
      code: "custom",
      path: ["actor", "type"],
      message: `${event.payload.messageKind} events require a ${expectedActorType} actor`,
    });
  }
  if (
    event.payload.messageKind === "user" &&
    event.payload.automationDepth !== 0
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["payload", "automationDepth"],
      message: "user events require automationDepth=0",
    });
  }
  if (
    event.payload.messageKind !== "user" &&
    event.payload.automationDepth < 1
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["payload", "automationDepth"],
      message: "bot-authored events require automationDepth>=1",
    });
  }
  if (
    event.payload.messageKind === "system_failure" &&
    event.payload.targetBotIds.length > 0
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["payload", "targetBotIds"],
      message: "system failure events cannot target bots",
    });
  }
  if (new Set(event.payload.targetBotIds).size !== event.payload.targetBotIds.length) {
    ctx.addIssue({
      code: "custom",
      path: ["payload", "targetBotIds"],
      message: "targetBotIds must be unique",
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
  conversationId: string;
  targetBotIds: string[];
  messageKind: z.infer<typeof chatMessageKindSchema>;
  automationDepth: number;
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
    payload: {
      messageId: input.messageId,
      conversationId: input.conversationId,
      targetBotIds: input.targetBotIds,
      messageKind: input.messageKind,
      automationDepth: input.automationDepth,
    },
  });
}
