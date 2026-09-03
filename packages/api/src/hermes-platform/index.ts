import { Elysia } from "elysia";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { bots, users } from "../db/schema";
import {
  cancelHermesPlatformInvocation,
  claimHermesPlatformEvents,
  completeHermesPlatformInvocationSilently,
  failHermesPlatformInvocation,
  publishHermesPlatformMessage,
  publishHermesPlatformProgress,
  publishHermesPlatformTyping,
} from "../services/bot-runtime";
import { ServiceError } from "../services/errors";
import { resolveTokenToUser } from "../auth/middleware";

const messageSchema = z.object({
  invocationId: z.string().min(1).optional(),
  botId: z.string().min(1).optional(),
  conversationId: z.string().min(1).optional(),
  chatId: z.string().min(1).optional(),
  threadId: z.string().min(1).nullish(),
  content: z.string().max(100_000).default(""),
  attachmentIds: z.array(z.string().uuid()).max(5).default([]),
  platformMessageId: z.string().trim().min(1).max(255).nullish(),
  complete: z.boolean().optional(),
}).refine(
  (value) => value.content.trim().length > 0 || value.attachmentIds.length > 0,
  { message: "Message text or at least one attachment is required" },
);

const typingSchema = z.object({
  invocationId: z.string().min(1),
  botId: z.string().min(1).optional(),
  conversationId: z.string().min(1).optional(),
  threadId: z.string().min(1).nullish(),
});

const MAX_PROGRESS_PAYLOAD_BYTES = 128 * 1024;
const MAX_PROGRESS_LABEL_LENGTH = 1_000;
const MAX_PROGRESS_PREVIEW_LENGTH = 10_000;
const MAX_PROGRESS_TOOL_TOKEN_LENGTH = 255;
const MAX_INTERACTION_REQUEST_ID_LENGTH = 255;
const MAX_INTERACTION_SESSION_KEY_LENGTH = 1_000;
const MAX_INTERACTION_QUESTION_LENGTH = 10_000;
const MAX_INTERACTION_COMMAND_LENGTH = 100_000;
const MAX_INTERACTION_DESCRIPTION_LENGTH = 10_000;
const MAX_INTERACTION_RESPONSE_LENGTH = 4_000;
const MAX_CLARIFY_CHOICE_LENGTH = 500;
const MAX_CLARIFY_CHOICES = 20;

const boundedToken = (max: number) =>
  z.string().min(1).max(max).refine((value) => value === value.trim(), {
    message: "Token must not contain surrounding whitespace",
  });

const approvalChoiceSchema = z.enum(["once", "session", "always", "deny"]);
const approvalRequestPayloadSchema = z.object({
  requestId: boundedToken(MAX_INTERACTION_REQUEST_ID_LENGTH),
  sessionKey: boundedToken(MAX_INTERACTION_SESSION_KEY_LENGTH),
  command: z.string().max(MAX_INTERACTION_COMMAND_LENGTH),
  description: z.string().max(MAX_INTERACTION_DESCRIPTION_LENGTH),
  choices: z.array(approvalChoiceSchema).min(1).max(4).refine(
    (choices) => new Set(choices).size === choices.length,
    { message: "Approval choices must be unique" },
  ),
}).strict();
const approvalResolvedPayloadSchema = z.object({
  requestId: boundedToken(MAX_INTERACTION_REQUEST_ID_LENGTH).optional(),
  sessionKey: boundedToken(MAX_INTERACTION_SESSION_KEY_LENGTH),
  choice: approvalChoiceSchema,
  resolveAll: z.boolean().optional(),
  resolvedCount: z.number().int().positive().max(10_000).optional(),
}).strict();
const clarifyChoicesSchema = z.array(
  z.string().trim().min(1).max(MAX_CLARIFY_CHOICE_LENGTH),
).min(1).max(MAX_CLARIFY_CHOICES).refine(
  (choices) => new Set(choices).size === choices.length,
  { message: "Clarification choices must be unique" },
);
const clarifyRequestPayloadSchema = z.object({
  requestId: boundedToken(MAX_INTERACTION_REQUEST_ID_LENGTH),
  sessionKey: boundedToken(MAX_INTERACTION_SESSION_KEY_LENGTH),
  question: z.string().trim().min(1).max(MAX_INTERACTION_QUESTION_LENGTH),
  choices: clarifyChoicesSchema.nullable(),
  multiSelect: z.boolean(),
  allowOther: z.literal(true),
}).strict().refine(
  (payload) => !payload.multiSelect || payload.choices !== null,
  { message: "Multi-select clarification requires choices" },
);
const clarifyResponseSchema = z.union([
  z.string().trim().min(1).max(MAX_INTERACTION_RESPONSE_LENGTH),
  z.array(z.string().trim().min(1).max(MAX_CLARIFY_CHOICE_LENGTH))
    .min(1)
    .max(MAX_CLARIFY_CHOICES),
]);
const clarifyResolvedPayloadSchema = z.object({
  requestId: boundedToken(MAX_INTERACTION_REQUEST_ID_LENGTH),
  sessionKey: boundedToken(MAX_INTERACTION_SESSION_KEY_LENGTH),
  response: clarifyResponseSchema,
}).strict();

const interactionProgressPayloadSchemas = {
  "approval.request": approvalRequestPayloadSchema,
  "approval.resolved": approvalResolvedPayloadSchema,
  "clarify.request": clarifyRequestPayloadSchema,
  "clarify.resolved": clarifyResolvedPayloadSchema,
} as const;

const progressSchema = z.object({
  botId: z.string().min(1).optional(),
  conversationId: z.string().min(1).optional(),
  type: z.string().min(1).max(64),
  status: z.string().min(1).max(32).nullish(),
  toolCallId: z.string().min(1).max(MAX_PROGRESS_TOOL_TOKEN_LENGTH).nullish(),
  toolName: z.string().min(1).max(MAX_PROGRESS_TOOL_TOKEN_LENGTH).nullish(),
  label: z.string().max(MAX_PROGRESS_LABEL_LENGTH).nullish(),
  preview: z.string().max(MAX_PROGRESS_PREVIEW_LENGTH).nullish(),
  payload: z.record(z.string(), z.unknown()).nullish(),
  occurredAt: z.string().datetime().nullish(),
}).superRefine((progress, context) => {
  if (progress.payload !== null && progress.payload !== undefined) {
    const serialized = JSON.stringify(progress.payload);
    if (new TextEncoder().encode(serialized).byteLength > MAX_PROGRESS_PAYLOAD_BYTES) {
      context.addIssue({
        code: "custom",
        path: ["payload"],
        message: "Progress payload is too large",
      });
    }
  }
  const interactionSchema = interactionProgressPayloadSchemas[
    progress.type as keyof typeof interactionProgressPayloadSchemas
  ];
  if (!interactionSchema) return;
  const parsed = interactionSchema.safeParse(progress.payload);
  if (parsed.success) return;
  for (const issue of parsed.error.issues) {
    context.addIssue({
      code: "custom",
      path: ["payload", ...issue.path],
      message: issue.message,
    });
  }
});

const failedSchema = z.object({
  error: z.string().min(1),
});

const silentCompleteSchema = z.object({
  reason: z.string().optional(),
});

const cancelledSchema = z.object({
  reason: z.string().optional(),
});

type HermesPlatformBot = {
  id: string;
  userId: string;
  name: string;
  kind: "webhook" | "hermes" | "hermes-rpc";
};

function authHeaderFrom(headers: Record<string, string | undefined> | Headers) {
  const authHeader =
    typeof (headers as Headers).get === "function"
      ? (headers as Headers).get("authorization")
      : (headers as Record<string, string | undefined>).authorization;
  return authHeader ?? "";
}

async function resolveHermesPlatformBot(headers: Record<string, string | undefined> | Headers): Promise<HermesPlatformBot | null> {
  const authHeader = authHeaderFrom(headers);
  if (!authHeader.startsWith("Bearer ")) return null;

  const token = authHeader.slice(7);
  if (!token.startsWith("bot_")) return null;

  const user = await resolveTokenToUser(token);
  if (!user || user.type !== "bot") return null;

  const [bot] = await db
    .select({
      id: bots.id,
      userId: bots.userId,
      kind: bots.kind,
      name: users.name,
    })
    .from(bots)
    .innerJoin(users, eq(bots.userId, users.id))
    .where(eq(bots.userId, user.id))
    .limit(1);

  if (!bot) return null;
  return bot;
}

function requireHermesBot(platformBot: HermesPlatformBot | null, set: { status?: any }) {
  if (!platformBot) {
    set.status = 401;
    return { error: "Valid bot token is required" };
  }
  if (platformBot.kind !== "hermes") {
    set.status = 403;
    return { error: "Bot token is not for a Hermes bot" };
  }
  return null;
}

export const hermesPlatformRoutes = new Elysia({ prefix: "/hermes-platform" })
  .derive(async ({ headers }) => ({
    platformBot: await resolveHermesPlatformBot(headers),
  }))
  .onBeforeHandle(({ platformBot, set }) => {
    const error = requireHermesBot(platformBot, set);
    if (error) return error;
  })
  .get("/health", ({ platformBot }) => ({
    ok: true,
    platform: "thechat",
    bot: platformBot ? { id: platformBot.id, userId: platformBot.userId, name: platformBot.name } : null,
  }))
  .get("/events", async ({ query, platformBot, set }) => {
    try {
      const rawLimit = typeof query.limit === "string" ? Number.parseInt(query.limit, 10) : 10;
      const events = await claimHermesPlatformEvents(platformBot!.id, Number.isFinite(rawLimit) ? rawLimit : 10);
      return { events };
    } catch (e: any) {
      set.status = e instanceof ServiceError ? e.status : 500;
      return { error: e.message ?? "Unknown error" };
    }
  })
  .post("/messages", async ({ body, platformBot, set }) => {
    const parsed = messageSchema.safeParse(body);
    if (!parsed.success) {
      set.status = 400;
      return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
    }
    try {
      return await publishHermesPlatformMessage({
        authenticatedBotId: platformBot!.id,
        invocationId: parsed.data.invocationId ?? null,
        botId: parsed.data.botId,
        conversationId: parsed.data.conversationId,
        chatId: parsed.data.chatId,
        threadId: parsed.data.threadId ?? null,
        content: parsed.data.content,
        attachmentIds: parsed.data.attachmentIds,
        platformMessageId: parsed.data.platformMessageId ?? null,
        complete: parsed.data.complete,
      });
    } catch (e: any) {
      set.status = e instanceof ServiceError ? e.status : 500;
      return { error: e.message ?? "Unknown error" };
    }
  })
  .post("/typing", async ({ body, platformBot, set }) => {
    const parsed = typingSchema.safeParse(body);
    if (!parsed.success) {
      set.status = 400;
      return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
    }
    try {
      return await publishHermesPlatformTyping({
        authenticatedBotId: platformBot!.id,
        ...parsed.data,
        threadId: parsed.data.threadId ?? null,
      });
    } catch (e: any) {
      set.status = e instanceof ServiceError ? e.status : 500;
      return { error: e.message ?? "Unknown error" };
    }
  })
  .post("/invocations/:invocationId/progress", async ({ params, body, platformBot, set }) => {
    const parsed = progressSchema.safeParse(body);
    if (!parsed.success) {
      set.status = 400;
      return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
    }
    try {
      return await publishHermesPlatformProgress({
        authenticatedBotId: platformBot!.id,
        invocationId: params.invocationId,
        ...parsed.data,
        status: parsed.data.status ?? null,
        toolCallId: parsed.data.toolCallId ?? null,
        toolName: parsed.data.toolName ?? null,
        label: parsed.data.label ?? null,
        preview: parsed.data.preview ?? null,
        payload: parsed.data.payload ?? null,
        occurredAt: parsed.data.occurredAt ? new Date(parsed.data.occurredAt) : null,
      });
    } catch (e: any) {
      set.status = e instanceof ServiceError ? e.status : 500;
      return { error: e.message ?? "Unknown error" };
    }
  })
  .post("/invocations/:invocationId/failed", async ({ params, body, platformBot, set }) => {
    const parsed = failedSchema.safeParse(body);
    if (!parsed.success) {
      set.status = 400;
      return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
    }
    try {
      return await failHermesPlatformInvocation({
        authenticatedBotId: platformBot!.id,
        invocationId: params.invocationId,
        error: parsed.data.error,
      });
    } catch (e: any) {
      set.status = e instanceof ServiceError ? e.status : 500;
      return { error: e.message ?? "Unknown error" };
    }
  })
  .post("/invocations/:invocationId/completed", async ({ params, body, platformBot, set }) => {
    const parsed = silentCompleteSchema.safeParse(body ?? {});
    if (!parsed.success) {
      set.status = 400;
      return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
    }
    try {
      return await completeHermesPlatformInvocationSilently({
        authenticatedBotId: platformBot!.id,
        invocationId: params.invocationId,
        reason: parsed.data.reason ?? null,
      });
    } catch (e: any) {
      set.status = e instanceof ServiceError ? e.status : 500;
      return { error: e.message ?? "Unknown error" };
    }
  })
  .post("/invocations/:invocationId/cancelled", async ({ params, body, platformBot, set }) => {
    const parsed = cancelledSchema.safeParse(body ?? {});
    if (!parsed.success) {
      set.status = 400;
      return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
    }
    try {
      return await cancelHermesPlatformInvocation({
        authenticatedBotId: platformBot!.id,
        invocationId: params.invocationId,
        reason: parsed.data.reason ?? null,
      });
    } catch (e: any) {
      set.status = e instanceof ServiceError ? e.status : 500;
      return { error: e.message ?? "Unknown error" };
    }
  });
