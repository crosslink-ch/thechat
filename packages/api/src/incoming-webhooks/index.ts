import { Elysia } from "elysia";
import { z } from "zod";
import { browserAuthPolicy } from "../auth/browser";
import { resolveRequestUser } from "../auth/middleware";
import { ServiceError } from "../services/errors";
import { createIncomingWebhook, listIncomingWebhooks, postIncomingWebhook, revokeIncomingWebhook, WebhookRateLimitError } from "./service";
import { messageFromPayload, readWebhookPayload } from "./payload";
import { withHttpServerSpan, setHttpResponseStatus } from "../observability";
import { log } from "../logging";
import { metrics } from "@opentelemetry/api";

const hookRequests = metrics.getMeter("thechat-api").createCounter("thechat.incoming_webhook.requests");

const uuid = z.string().uuid();
const nameSchema = z.object({ name: z.string().trim().min(1).max(100) });
const management = new Elysia({ prefix: "/channels/:conversationId/incoming-webhooks" })
  .use(browserAuthPolicy)
  .derive(async ({ headers }) => ({ user: await resolveRequestUser(headers, { includeBotTokens: false }) }))
  .onBeforeHandle(({ user, params, set }) => {
    set.headers["cache-control"] = "no-store";
    if (!user) { set.status = 401; return { error: "Authentication required" }; }
    if (!uuid.safeParse(params.conversationId).success) { set.status = 404; return { error: "Channel not found" }; }
  })
  .onError(({ error, set }) => {
    if (error instanceof ServiceError) { set.status = error.status; return { error: error.message }; }
  })
  .get("/", ({ params, user }) => listIncomingWebhooks(params.conversationId, user!.id))
  .post("/", async ({ params, user, body, set }) => {
    const parsed = nameSchema.safeParse(body);
    if (!parsed.success) { set.status = 400; return { error: "Webhook name must be between 1 and 100 characters" }; }
    const result = await createIncomingWebhook(params.conversationId, user!.id, parsed.data.name);
    set.status = 201;
    return result;
  })
  .delete("/:webhookId", ({ params, user, set }) => {
    if (!uuid.safeParse(params.webhookId).success) { set.status = 404; return { error: "Webhook not found" }; }
    return revokeIncomingWebhook(params.conversationId, user!.id, params.webhookId);
  });

export const incomingWebhookRoutes = new Elysia()
  .use(management)
  .post("/hooks/incoming/:token", ({ params, request, headers, set }) => withHttpServerSpan("POST", "/hooks/incoming/:token", headers, async span => {
    set.headers["cache-control"] = "no-store";
    try {
      const content = messageFromPayload(await readWebhookPayload(request));
      await postIncomingWebhook(params.token, content);
      set.status = 200;
      return "ok";
    } catch (error) {
      if (error instanceof WebhookRateLimitError) set.headers["retry-after"] = String(error.retryAfter);
      if (error instanceof ServiceError) { set.status = error.status; return { error: error.message }; }
      // Database errors can contain token hashes and message text: never log
      // them, the request context, or the complete URL.
      log.error({ component: "incoming-webhooks" }, "incoming_webhook.failed");
      set.status = 503;
      return { error: "Webhook service temporarily unavailable" };
    } finally {
      setHttpResponseStatus(span, set.status);
      hookRequests.add(1, { "http.response.status_code": Number(set.status) });
    }
  }), { parse: "none" });

/** URL credentials must not reach Elysia's automatic request/error logger. */
export function isIncomingWebhookRequest(request: Request) {
  try { return decodeURIComponent(new URL(request.url).pathname).startsWith("/hooks/incoming/"); }
  catch { return new URL(request.url).pathname.startsWith("/hooks/"); }
}
