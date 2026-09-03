import { Elysia } from "elysia";
import { resolveTokenToUser } from "../auth/middleware";
import { ServiceError } from "../services/errors";
import { listDirectHermesSessions } from "../services/hermes-rpc";

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
  .get("/:botId/hermes-rpc/sessions", async ({ params, user, set }) => {
    try {
      return await listDirectHermesSessions(params.botId, user.id);
    } catch (error) {
      set.status = error instanceof ServiceError ? error.status : 500;
      return {
        error: error instanceof Error
          ? error.message
          : "Unknown Direct Hermes error",
      };
    }
  });
