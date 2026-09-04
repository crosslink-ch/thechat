import { Elysia } from "elysia";
import { z } from "zod";
import { resolveTokenToUser } from "../auth/middleware";
import { ServiceError } from "../services/errors";
import { issueDirectHermesProxyTicket } from "../services/hermes-proxy-access";

const proxyTicketSchema = z.object({
  conversationId: z.string().uuid(),
});

export const hermesRpcRoutes = new Elysia({ prefix: "/bots" })
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
  .post(
    "/:botId/hermes-rpc/proxy-ticket",
    async ({ body, params, user, set }) => {
      set.headers["cache-control"] = "no-store";
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
        if (error instanceof ServiceError) {
          set.status = error.status;
          return { error: error.message };
        }
        set.status = 500;
        return { error: "Could not issue Direct Hermes proxy ticket" };
      }
    },
  );
