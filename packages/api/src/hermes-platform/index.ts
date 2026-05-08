import { Elysia } from "elysia";
import { z } from "zod";
import {
  claimHermesPlatformEvents,
  completeHermesPlatformInvocation,
  failHermesPlatformInvocation,
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

const failedSchema = z.object({
  error: z.string().min(1),
});

function requirePlatformAuth(headers: Record<string, string | undefined> | Headers, set: { status?: any }) {
  const token = process.env.THECHAT_HERMES_PLATFORM_TOKEN ?? process.env.THECHAT_PLATFORM_TOKEN;
  if (!token) {
    set.status = 503;
    return { error: "TheChat Hermes platform token is not configured" };
  }
  const authHeader =
    typeof (headers as Headers).get === "function"
      ? (headers as Headers).get("authorization")
      : (headers as Record<string, string | undefined>).authorization;
  if (authHeader !== `Bearer ${token}`) {
    set.status = 401;
    return { error: "Invalid Hermes platform token" };
  }
  return null;
}

export const hermesPlatformRoutes = new Elysia({ prefix: "/hermes-platform" })
  .onBeforeHandle(({ headers, set }) => {
    const error = requirePlatformAuth(headers, set);
    if (error) return error;
  })
  .get("/health", () => ({ ok: true, platform: "thechat" }))
  .get("/events", async ({ query, set }) => {
    try {
      const rawLimit = typeof query.limit === "string" ? Number.parseInt(query.limit, 10) : 10;
      const events = await claimHermesPlatformEvents(Number.isFinite(rawLimit) ? rawLimit : 10);
      return { events };
    } catch (e: any) {
      set.status = e instanceof ServiceError ? e.status : 500;
      return { error: e.message ?? "Unknown error" };
    }
  })
  .post("/messages", async ({ body, set }) => {
    const parsed = completeSchema.safeParse(body);
    if (!parsed.success) {
      set.status = 400;
      return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
    }
    try {
      return await completeHermesPlatformInvocation({
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
  .post("/typing", async ({ body, set }) => {
    const parsed = typingSchema.safeParse(body);
    if (!parsed.success) {
      set.status = 400;
      return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
    }
    try {
      return await publishHermesPlatformTyping(parsed.data);
    } catch (e: any) {
      set.status = e instanceof ServiceError ? e.status : 500;
      return { error: e.message ?? "Unknown error" };
    }
  })
  .post("/invocations/:invocationId/failed", async ({ params, body, set }) => {
    const parsed = failedSchema.safeParse(body);
    if (!parsed.success) {
      set.status = 400;
      return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
    }
    try {
      return await failHermesPlatformInvocation({
        invocationId: params.invocationId,
        error: parsed.data.error,
      });
    } catch (e: any) {
      set.status = e instanceof ServiceError ? e.status : 500;
      return { error: e.message ?? "Unknown error" };
    }
  });
