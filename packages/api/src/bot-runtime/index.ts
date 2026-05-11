import { Elysia } from "elysia";
import { z } from "zod";
import { resolveTokenToUser } from "../auth/middleware";
import { ServiceError } from "../services/errors";
import {
  createHermesConversationSession,
  listConversationBotRuntime,
} from "../services/bot-runtime";

const createSessionSchema = z.object({
  botId: z.string().uuid().optional(),
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
  .post("/conversations/:conversationId/sessions", async ({ params, body, user, set }) => {
    const parsed = createSessionSchema.safeParse(body ?? {});
    if (!parsed.success) {
      set.status = 400;
      return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
    }
    try {
      return await createHermesConversationSession({
        conversationId: params.conversationId,
        userId: user.id,
        botId: parsed.data.botId ?? null,
      });
    } catch (e: any) {
      set.status = e instanceof ServiceError ? e.status : 500;
      return { error: e.message ?? "Unknown error" };
    }
  });
