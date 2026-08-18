import { Elysia } from "elysia";
import { z } from "zod";
import { resolveTokenToUser } from "../auth/middleware";
import { ServiceError } from "../services/errors";
import {
  listConversationBotRuntime,
  submitHermesPlatformInteraction,
} from "../services/bot-runtime";

const interactionResponseSchema = z.object({
  response: z.union([
    z.string().max(4_000),
    z.array(z.string().max(500)).min(1).max(20),
  ]),
});

export const botRuntimeRoutes = new Elysia({ prefix: "/bot-runtime" })
  .derive(async ({ headers }) => {
    const authHeader = headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) return { user: null } as any;
    const user = await resolveTokenToUser(authHeader.slice(7));
    return { user } as any;
  })
  .onBeforeHandle(({ user, set }) => {
    if (!user) {
      set.status = 401;
      return { error: "Authentication required" };
    }
  })
  .get("/conversations/:conversationId", async ({ params, user, set }) => {
    try {
      return await listConversationBotRuntime(params.conversationId, user.id);
    } catch (e: any) {
      set.status = e instanceof ServiceError ? e.status : 500;
      return { error: e.message ?? "Unknown error" };
    }
  })
  .post(
    "/invocations/:invocationId/interactions/:eventId",
    async ({ params, body, user, set }) => {
      const parsed = interactionResponseSchema.safeParse(body);
      if (!parsed.success) {
        set.status = 400;
        return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
      }
      try {
        return await submitHermesPlatformInteraction({
          userId: user.id,
          userType: user.type,
          invocationId: params.invocationId,
          eventId: params.eventId,
          response: parsed.data.response,
        });
      } catch (e: any) {
        set.status = e instanceof ServiceError ? e.status : 500;
        return {
          error:
            e instanceof ServiceError
              ? e.message
              : "Failed to deliver the Hermes interaction",
        };
      }
    },
  );
