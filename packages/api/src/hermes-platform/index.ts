import { Elysia } from "elysia";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { bots, users } from "../db/schema";
import {
  cancelHermesPlatformInvocation,
  claimHermesPlatformEvents,
  completeHermesPlatformInvocation,
  completeHermesPlatformInvocationSilently,
  failHermesPlatformInvocation,
  publishHermesPlatformProgress,
  publishHermesPlatformTyping,
} from "../services/bot-runtime";
import { ServiceError } from "../services/errors";

const completeSchema = z.object({
  invocationId: z.string().min(1),
  botId: z.string().min(1).optional(),
  conversationId: z.string().min(1).optional(),
  content: z.string().min(1),
  platformMessageId: z.string().nullish(),
});

const typingSchema = z.object({
  invocationId: z.string().min(1),
  botId: z.string().min(1).optional(),
  conversationId: z.string().min(1).optional(),
});

const progressSchema = z.object({
  botId: z.string().min(1).optional(),
  conversationId: z.string().min(1).optional(),
  type: z.string().min(1).max(64),
  status: z.string().min(1).max(32).nullish(),
  toolCallId: z.string().min(1).nullish(),
  toolName: z.string().min(1).nullish(),
  label: z.string().nullish(),
  preview: z.string().nullish(),
  payload: z.record(z.string(), z.unknown()).nullish(),
  occurredAt: z.string().datetime().nullish(),
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
  kind: "webhook" | "hermes";
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

  const [bot] = await db
    .select({
      id: bots.id,
      userId: bots.userId,
      kind: bots.kind,
      name: users.name,
    })
    .from(bots)
    .innerJoin(users, eq(bots.userId, users.id))
    .where(eq(bots.apiKey, token))
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
    const parsed = completeSchema.safeParse(body);
    if (!parsed.success) {
      set.status = 400;
      return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
    }
    try {
      return await completeHermesPlatformInvocation({
        authenticatedBotId: platformBot!.id,
        invocationId: parsed.data.invocationId,
        botId: parsed.data.botId,
        conversationId: parsed.data.conversationId,
        content: parsed.data.content,
        platformMessageId: parsed.data.platformMessageId ?? null,
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
