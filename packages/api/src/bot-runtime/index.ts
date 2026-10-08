import { Elysia } from "elysia";
import { z } from "zod";
import { resolveRequestUser } from "../auth/middleware";
import { browserAuthPolicy } from "../auth/browser";
import { ServiceError } from "../services/errors";
import {
  listConversationBotRuntime,
  submitHermesPlatformInteraction,
  submitHermesPlatformVaultUnlock,
} from "../services/bot-runtime";
import { vaultUnlockResponseSchema } from "../services/vault-unlock";

const interactionResponseSchema = z.object({
  response: z.union([
    z.string().max(4_000),
    z.array(z.string().max(500)).min(1).max(20),
  ]),
});

export const botRuntimeRoutes = new Elysia({ prefix: "/bot-runtime" })
  .onRequest(({request,set})=> {
    if (new URL(request.url).pathname.endsWith("/vault-unlock")) set.headers["Cache-Control"] = "no-store";
  })
  .onError(({request,set,code})=> {
    if (!new URL(request.url).pathname.endsWith("/vault-unlock")) return;
    set.headers["Cache-Control"] = "no-store";
    set.status = code === "PARSE" || code === "VALIDATION" ? 400 : 500;
    return {error:"Could not deliver the vault unlock response"};
  })
  .use(browserAuthPolicy)
  .derive(async ({ headers }) => ({ user: await resolveRequestUser(headers) } as any))
  .onBeforeHandle(({ user, set, path }) => {
    if (path.endsWith("/vault-unlock")) set.headers["Cache-Control"] = "no-store";
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
  )
  .post("/invocations/:invocationId/interactions/:eventId/vault-unlock", async ({params, body, user, set}) => {
    set.headers["Cache-Control"] = "no-store";
    const parsed = vaultUnlockResponseSchema.safeParse(body);
    if (!parsed.success) { set.status = 400; return {error: "Invalid vault unlock response"}; }
    try {
      return await submitHermesPlatformVaultUnlock({userId:user.id,userType:user.type,invocationId:params.invocationId,eventId:params.eventId,response:parsed.data});
    } catch (error) {
      set.status = error instanceof ServiceError ? error.status : 500;
      return {error: "Could not deliver the vault unlock response"};
    }
  });
