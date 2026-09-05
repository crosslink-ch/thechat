import { Elysia } from "elysia";
import { z } from "zod";
import { resolveTokenToUser } from "../auth/middleware";
import { ServiceError } from "../services/errors";
import { issueDirectHermesProxyTicket } from "../services/hermes-proxy-access";
import {
  getDirectHermesSettings,
  updateDirectHermesSettings,
  directHermesSettingsPatchSchema,
} from "../services/hermes-rpc-settings";

const botParamsSchema = z.object({ botId: z.string().uuid() });
const proxyTicketSchema = z.object({ conversationId: z.string().uuid() });

export const hermesRpcRoutes = new Elysia({ prefix: "/bots" })
  .onRequest(({ set }) => {
    set.headers["cache-control"] = "no-store";
  })
  .onError(({ code, set }) => {
    if (code === "VALIDATION" || code === "PARSE") {
      set.status = 400;
      // Never return framework validation details containing submitted secrets.
      return { error: "Invalid Direct Hermes request" };
    }
  })
  .derive(async ({ headers }) => {
    const authHeader = headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) return { user: null } as any;
    const user = await resolveTokenToUser(authHeader.slice(7), {
      includeBotTokens: false,
    });
    return { user } as any;
  })
  .onBeforeHandle(({ user, set }) => {
    if (!user) {
      set.status = 401;
      return { error: "Authentication required" };
    }
  })
  .patch(
    "/:botId/hermes-rpc/settings",
    async ({ params, user, body, set }) => {
      try {
        return await updateDirectHermesSettings(params.botId, user.id, body);
      } catch (error) {
        set.status = error instanceof ServiceError ? error.status : 500;
        return {
          error:
            error instanceof ServiceError
              ? error.message
              : "Could not update Direct Hermes settings",
        };
      }
    },
    { params: botParamsSchema, body: directHermesSettingsPatchSchema },
  )
  .get(
    "/:botId/hermes-rpc/settings",
    async ({ params, user, set }) => {
      try {
        return await getDirectHermesSettings(params.botId, user.id);
      } catch (error) {
        set.status = error instanceof ServiceError ? error.status : 500;
        return {
          error:
            error instanceof ServiceError
              ? error.message
              : "Could not read Direct Hermes settings",
        };
      }
    },
    { params: botParamsSchema },
  )
  .post(
    "/:botId/hermes-rpc/proxy-ticket",
    async ({ body, params, user, set }) => {
      const parsed = proxyTicketSchema.safeParse(body);
      if (!parsed.success) {
        set.status = 400;
        return { error: "A valid conversationId is required" };
      }
      try {
        return await issueDirectHermesProxyTicket(
          params.botId,
          parsed.data.conversationId,
          user.id,
        );
      } catch (error) {
        set.status = error instanceof ServiceError ? error.status : 500;
        return {
          error:
            error instanceof ServiceError
              ? error.message
              : "Could not issue Direct Hermes proxy ticket",
        };
      }
    },
    { params: botParamsSchema },
  );
