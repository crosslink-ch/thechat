import crypto from "crypto";
import { z } from "zod";
import { domainEventEnvelopeSchema } from "../events/envelope";
import { activeTraceContext } from "../observability";

export const BOT_REQUEST_ANSWERED_EVENT_TYPE = "bot.request.answered";
export const BOT_REQUEST_ANSWERED_EVENT_VERSION = 1;

/**
 * Staged in the same transaction as the answer. The handler re-reads the row,
 * so the event only carries identity and never the answer itself.
 */
export const botRequestAnsweredV1Schema = domainEventEnvelopeSchema
  .extend({
    type: z.literal(BOT_REQUEST_ANSWERED_EVENT_TYPE),
    version: z.literal(BOT_REQUEST_ANSWERED_EVENT_VERSION),
    aggregate: z.object({
      type: z.literal("bot_request"),
      id: z.string().uuid(),
    }),
    payload: z.object({
      requestId: z.string().uuid(),
      botId: z.string().uuid(),
    }),
  })
  .superRefine((event, ctx) => {
    if (event.aggregate.id !== event.payload.requestId) {
      ctx.addIssue({
        code: "custom",
        path: ["payload", "requestId"],
        message: "payload.requestId must match aggregate.id",
      });
    }
  });

export type BotRequestAnsweredV1 = z.infer<typeof botRequestAnsweredV1Schema>;

export function parseBotRequestAnsweredV1(value: unknown): BotRequestAnsweredV1 {
  return botRequestAnsweredV1Schema.parse(value);
}

export function createBotRequestAnsweredV1(input: {
  requestId: string;
  botId: string;
  answeredBy: string;
  workspaceId?: string | null;
  occurredAt?: Date;
}): BotRequestAnsweredV1 {
  const traceContext = activeTraceContext();
  return botRequestAnsweredV1Schema.parse({
    id: crypto.randomUUID(),
    type: BOT_REQUEST_ANSWERED_EVENT_TYPE,
    version: BOT_REQUEST_ANSWERED_EVENT_VERSION,
    aggregate: { type: "bot_request", id: input.requestId },
    actor: { type: "human", id: input.answeredBy },
    ...(input.workspaceId ? { tenant: { workspaceId: input.workspaceId } } : {}),
    correlationId: input.requestId,
    ...(traceContext ? { traceContext } : {}),
    occurredAt: (input.occurredAt ?? new Date()).toISOString(),
    payload: { requestId: input.requestId, botId: input.botId },
  });
}
