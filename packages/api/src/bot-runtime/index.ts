import { Elysia } from "elysia";
import { resolveRequestUser } from "../auth/middleware";
import { browserAuthPolicy } from "../auth/browser";
import { ServiceError } from "../services/errors";
import {
  listConversationBotRuntime,
  submitHermesPlatformVaultUnlock,
  submitHermesPlatformSecureInput,
} from "../services/bot-runtime";
import { vaultUnlockResponseSchema } from "../services/vault-unlock";
import { secureInputResponseSchema } from "../services/secure-input";

const isSecurePath = (path: string) => path.endsWith("/vault-unlock") || path.endsWith("/secure-input");

export const botRuntimeRoutes = new Elysia({ prefix: "/bot-runtime" })
  .onRequest(({request,set})=> {
    if (isSecurePath(new URL(request.url).pathname)) set.headers["Cache-Control"] = "no-store";
  })
  .onError(({request,set,code})=> {
    if (!isSecurePath(new URL(request.url).pathname)) return;
    set.headers["Cache-Control"] = "no-store";
    set.status = code === "PARSE" || code === "VALIDATION" ? 400 : 500;
    return {error: new URL(request.url).pathname.endsWith("/secure-input") ? "Could not deliver the secure input response" : "Could not deliver the vault unlock response"};
  })
  .use(browserAuthPolicy)
  .derive(async ({ headers }) => ({ user: await resolveRequestUser(headers) } as any))
  .onBeforeHandle(({ user, set, path }) => {
    if (isSecurePath(path)) set.headers["Cache-Control"] = "no-store";
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
  .post("/invocations/:invocationId/interactions/:eventId/secure-input", async ({ params, body, user, set }) => {
    set.headers["Cache-Control"] = "no-store";
    const parsed = secureInputResponseSchema.safeParse(body);
    if (!parsed.success) { set.status = 400; return { error: "Invalid secure input response" }; }
    try {
      return await submitHermesPlatformSecureInput({ userId: user.id, userType: user.type, invocationId: params.invocationId, eventId: params.eventId, response: parsed.data });
    } catch (error) {
      set.status = error instanceof ServiceError ? error.status : 500;
      return { error: "Could not deliver the secure input response" };
    }
  })
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
