import crypto from "node:crypto";
import { Elysia } from "elysia";
import { z } from "zod";
import { auth } from "../auth/better-auth";
import { browserAuthPolicy } from "../auth/browser";
import {
  AuthInfrastructureError,
  requestSessionToken,
  resolveRequestUser,
} from "../auth/middleware";
import { log } from "../logging";
import { ServiceError } from "../services/errors";
import { webPushConfig } from "./config";
import { MAX_PUSH_ENDPOINT_LENGTH } from "./endpoint";
import { deliverPushNotification } from "./jobs";
import {
  getNotificationPreferences,
  updateNotificationPreferences,
} from "./preferences";
import {
  findSessionPushSubscription,
  registerPushSubscription,
  removePushSubscription,
} from "./subscriptions";

const pushRouteLog = log.child({ component: "push-routes" });

const endpointSchema = z.string().url().max(MAX_PUSH_ENDPOINT_LENGTH);
const base64UrlSchema = z.string().min(1).max(128);

const subscribeSchema = z
  .object({
    endpoint: endpointSchema,
    keys: z.object({ p256dh: base64UrlSchema, auth: base64UrlSchema }).strict(),
    applicationServerKey: base64UrlSchema,
    userAgent: z.string().max(512).nullish(),
  })
  .strict();

const endpointBodySchema = z.object({ endpoint: endpointSchema }).strict();

const preferencesSchema = z
  .object({
    directMessages: z.boolean(),
    mentions: z.boolean(),
    agentReplies: z.boolean(),
    agentRequests: z.boolean(),
    showPreviews: z.boolean(),
  })
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one preference is required",
  });

type PushActor = { id: string; type: "human" | "bot" };

const TEST_NOTIFICATION_INTERVAL_MS = 5_000;
const lastTestNotificationAt = new Map<string, number>();

/** The signed-in session this request belongs to (not bot keys or PATs). */
async function currentSessionId(headers: Record<string, string | undefined>) {
  const token = requestSessionToken(headers);
  if (!token) return null;
  try {
    const result = await auth.api.getSession({
      headers: new Headers({ authorization: `Bearer ${token}` }),
    });
    return result?.session?.id ?? null;
  } catch (error) {
    throw new AuthInfrastructureError(error);
  }
}

function invalid(set: { status?: unknown }, error: z.ZodError) {
  set.status = 400;
  const issue = error.issues[0];
  return {
    error: issue ? `${issue.path.join(".") || "body"}: ${issue.message}` : "Invalid input",
  };
}

function fail(set: { status?: unknown }, error: unknown) {
  if (error instanceof ServiceError) {
    set.status = error.status;
    return { error: error.message };
  }
  throw error;
}

function notConfigured(set: { status?: unknown }) {
  set.status = 503;
  return { error: "Background notifications are not configured on this server" };
}

const authenticated = new Elysia({ name: "push-auth" })
  .use(browserAuthPolicy)
  .derive(async ({ headers }) => ({
    actor: (await resolveRequestUser(headers, {
      includeBotTokens: false,
    })) as PushActor | null,
  }))
  .onBeforeHandle(({ actor, set }) => {
    if (!actor || actor.type !== "human") {
      set.status = 401;
      return { error: "Authentication required" };
    }
  })
  .as("scoped");

/**
 * Web Push registration for the browser edition. A device is bound to the
 * signed-in session that registered it, so it stops receiving notifications
 * when that session ends.
 */
export const pushRoutes = new Elysia({ prefix: "/push" })
  .use(authenticated)
  .get("/config", () => {
    const config = webPushConfig();
    return config
      ? { enabled: true as const, publicKey: config.publicKey }
      : { enabled: false as const, publicKey: null };
  })
  .get("/preferences", async ({ actor }) => getNotificationPreferences(actor!.id))
  .patch("/preferences", async ({ actor, body, set }) => {
    const parsed = preferencesSchema.safeParse(body);
    if (!parsed.success) return invalid(set, parsed.error);
    return updateNotificationPreferences(actor!.id, parsed.data);
  })
  .post("/subscriptions", async ({ actor, body, headers, set }) => {
    const config = webPushConfig();
    if (!config) return notConfigured(set);
    const parsed = subscribeSchema.safeParse(body);
    if (!parsed.success) return invalid(set, parsed.error);
    const sessionId = await currentSessionId(headers);
    if (!sessionId) {
      set.status = 403;
      return { error: "Notifications need a signed-in browser session" };
    }
    try {
      const subscription = await registerPushSubscription(
        actor!.id,
        sessionId,
        { ...parsed.data, userAgent: parsed.data.userAgent ?? headers["user-agent"] },
        config.publicKey,
      );
      return { registered: true as const, id: subscription.id };
    } catch (error) {
      return fail(set, error);
    }
  })
  .post("/subscriptions/status", async ({ actor, body, headers, set }) => {
    const config = webPushConfig();
    const parsed = endpointBodySchema.safeParse(body);
    if (!parsed.success) return invalid(set, parsed.error);
    const sessionId = await currentSessionId(headers);
    const row = sessionId
      ? await findSessionPushSubscription(actor!.id, sessionId, parsed.data.endpoint)
      : null;
    return {
      registered: Boolean(row),
      current: Boolean(row && config && row.applicationServerKey === config.publicKey),
    };
  })
  .delete("/subscriptions", async ({ actor, body, set }) => {
    const parsed = endpointBodySchema.safeParse(body);
    if (!parsed.success) return invalid(set, parsed.error);
    return { removed: await removePushSubscription(actor!.id, parsed.data.endpoint) };
  })
  .post("/test", async ({ actor, body, headers, set }) => {
    const config = webPushConfig();
    if (!config) return notConfigured(set);
    const parsed = endpointBodySchema.safeParse(body);
    if (!parsed.success) return invalid(set, parsed.error);
    const now = Date.now();
    const last = lastTestNotificationAt.get(actor!.id) ?? 0;
    if (now - last < TEST_NOTIFICATION_INTERVAL_MS) {
      set.status = 429;
      return { error: "Wait a few seconds before sending another test" };
    }
    const sessionId = await currentSessionId(headers);
    const row = sessionId
      ? await findSessionPushSubscription(actor!.id, sessionId, parsed.data.endpoint)
      : null;
    if (!row) {
      set.status = 404;
      return { error: "Notifications are not turned on for this device" };
    }
    for (const [userId, at] of lastTestNotificationAt) {
      if (now - at >= TEST_NOTIFICATION_INTERVAL_MS) lastTestNotificationAt.delete(userId);
    }
    lastTestNotificationAt.set(actor!.id, now);
    try {
      const result = await deliverPushNotification({
        source: { type: "test", nonce: crypto.randomUUID() },
        subscriptionId: row.id,
        userId: actor!.id,
      });
      return { result: result.status };
    } catch (error) {
      pushRouteLog.warn({ err: error }, "Test notification could not be sent");
      set.status = 502;
      return { error: "The push service is unavailable. Try again shortly." };
    }
  });
