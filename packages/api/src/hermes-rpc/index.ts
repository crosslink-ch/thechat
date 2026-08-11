import { Elysia } from "elysia";
import { z } from "zod";
import { resolveTokenToUser } from "../auth/middleware";
import { ServiceError } from "../services/errors";
import {
  getHermesRpcBotConfig,
  listHermesRpcSessions,
  selectHermesRpcSession,
  testHermesRpcBot,
  updateHermesRpcBotConfig,
} from "../services/hermes-rpc";

export const hermesRpcBotUpdateSchema = z
  .object({
    endpoint: z.string().trim().min(1).optional(),
    gatewayToken: z.string().trim().max(4096).nullable().optional(),
  })
  .strict();

const sessionsQuerySchema = z.object({
  conversationId: z.string().uuid(),
});

const selectSessionSchema = z.object({
  conversationId: z.string().uuid(),
  upstreamSessionId: z.string().trim().min(1).max(255),
});

export const hermesRpcRoutes = new Elysia({ prefix: "/bots" })
  .derive(async ({ headers }) => {
    const authHeader = headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) return { user: null } as any;
    const user = await resolveTokenToUser(authHeader.slice(7), { includeBotTokens: false });
    return { user } as any;
  })
  .onBeforeHandle(({ user, set }) => {
    if (!user) {
      set.status = 401;
      return { error: "Authentication required" };
    }
  })
  .get("/:botId/hermes-rpc", async ({ params, user, set }) => {
    try {
      return await getHermesRpcBotConfig(params.botId, user.id);
    } catch (error) {
      return serviceErrorResponse(error, set);
    }
  })
  .patch("/:botId/hermes-rpc", async ({ params, body, user, set }) => {
    const parsed = hermesRpcBotUpdateSchema.safeParse(body);
    if (!parsed.success) {
      set.status = 400;
      return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
    }
    try {
      return await updateHermesRpcBotConfig(params.botId, user.id, parsed.data);
    } catch (error) {
      return serviceErrorResponse(error, set);
    }
  })
  .post("/:botId/hermes-rpc/test", async ({ params, user, set }) => {
    try {
      return await testHermesRpcBot(params.botId, user.id);
    } catch (error) {
      return serviceErrorResponse(error, set);
    }
  })
  .get("/:botId/hermes-rpc/sessions", async ({ params, query, user, set }) => {
    const parsed = sessionsQuerySchema.safeParse(query);
    if (!parsed.success) {
      set.status = 400;
      return { error: parsed.error.issues[0]?.message ?? "Invalid query" };
    }
    try {
      return await listHermesRpcSessions({
        botId: params.botId,
        conversationId: parsed.data.conversationId,
        userId: user.id,
      });
    } catch (error) {
      return serviceErrorResponse(error, set);
    }
  })
  .post("/:botId/hermes-rpc/sessions/select", async ({ params, body, user, set }) => {
    const parsed = selectSessionSchema.safeParse(body);
    if (!parsed.success) {
      set.status = 400;
      return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
    }
    try {
      return await selectHermesRpcSession({
        botId: params.botId,
        conversationId: parsed.data.conversationId,
        upstreamSessionId: parsed.data.upstreamSessionId,
        userId: user.id,
      });
    } catch (error) {
      return serviceErrorResponse(error, set);
    }
  });

function serviceErrorResponse(error: unknown, set: { status?: number | string }) {
  set.status = error instanceof ServiceError ? error.status : 500;
  return {
    error: error instanceof Error ? error.message : "Unknown Hermes RPC error",
  };
}
