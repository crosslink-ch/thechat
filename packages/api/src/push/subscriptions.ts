import { and, desc, eq, gt, inArray, ne, notInArray, sql } from "drizzle-orm";
import { db } from "../db";
import { pushSubscriptions, session } from "../db/schema";
import { ServiceError } from "../services/errors";
import {
  isAllowedPushEndpoint,
  isValidAuthSecret,
  isValidP256dhKey,
} from "./endpoint";

/** Old browsers and reinstalls leave dead rows; keep only the newest devices. */
export const MAX_PUSH_SUBSCRIPTIONS_PER_USER = 20;

export interface PushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  /** The VAPID public key the browser subscribed with (base64url). */
  applicationServerKey: string;
  userAgent?: string | null;
}

export class StalePushKeyError extends ServiceError {
  constructor() {
    super("This device subscribed with an old server key. Subscribe again.", 409);
  }
}

export function validatePushSubscriptionInput(
  input: PushSubscriptionInput,
  currentPublicKey: string,
) {
  if (!isAllowedPushEndpoint(input.endpoint)) {
    throw new ServiceError("This push service is not supported", 400);
  }
  if (!isValidP256dhKey(input.keys.p256dh) || !isValidAuthSecret(input.keys.auth)) {
    throw new ServiceError("Invalid push subscription keys", 400);
  }
  if (input.applicationServerKey !== currentPublicKey) throw new StalePushKeyError();
}

/**
 * Register (or refresh) this browser for the signed-in session. The endpoint
 * identifies the browser, so registering it again moves it to the newest
 * session, and a session keeps only its current browser subscription.
 */
export async function registerPushSubscription(
  userId: string,
  sessionId: string,
  input: PushSubscriptionInput,
  currentPublicKey: string,
) {
  validatePushSubscriptionInput(input, currentPublicKey);
  const userAgent = input.userAgent?.slice(0, 255) || null;
  return db.transaction(async (tx) => {
    await tx
      .delete(pushSubscriptions)
      .where(
        and(
          eq(pushSubscriptions.sessionId, sessionId),
          ne(pushSubscriptions.endpoint, input.endpoint),
        ),
      );
    const [row] = await tx
      .insert(pushSubscriptions)
      .values({
        userId,
        sessionId,
        endpoint: input.endpoint,
        p256dh: input.keys.p256dh,
        auth: input.keys.auth,
        applicationServerKey: input.applicationServerKey,
        userAgent,
      })
      .onConflictDoUpdate({
        target: pushSubscriptions.endpoint,
        set: {
          userId,
          sessionId,
          p256dh: input.keys.p256dh,
          auth: input.keys.auth,
          applicationServerKey: input.applicationServerKey,
          userAgent,
          failureCount: 0,
          updatedAt: new Date(),
        },
      })
      .returning({ id: pushSubscriptions.id });

    const keep = await tx
      .select({ id: pushSubscriptions.id })
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, userId))
      .orderBy(desc(pushSubscriptions.updatedAt), desc(pushSubscriptions.id))
      .limit(MAX_PUSH_SUBSCRIPTIONS_PER_USER);
    await tx.delete(pushSubscriptions).where(
      and(
        eq(pushSubscriptions.userId, userId),
        notInArray(
          pushSubscriptions.id,
          keep.map((entry) => entry.id),
        ),
      ),
    );
    return { id: row!.id };
  });
}

export async function removePushSubscription(userId: string, endpoint: string) {
  const removed = await db
    .delete(pushSubscriptions)
    .where(
      and(eq(pushSubscriptions.userId, userId), eq(pushSubscriptions.endpoint, endpoint)),
    )
    .returning({ id: pushSubscriptions.id });
  return removed.length > 0;
}

export async function findSessionPushSubscription(
  userId: string,
  sessionId: string,
  endpoint: string,
) {
  const [row] = await db
    .select({
      id: pushSubscriptions.id,
      applicationServerKey: pushSubscriptions.applicationServerKey,
    })
    .from(pushSubscriptions)
    .where(
      and(
        eq(pushSubscriptions.userId, userId),
        eq(pushSubscriptions.sessionId, sessionId),
        eq(pushSubscriptions.endpoint, endpoint),
      ),
    )
    .limit(1);
  return row ?? null;
}

export type DeliverablePushSubscription = {
  id: string;
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
};

const deliverableColumns = {
  id: pushSubscriptions.id,
  userId: pushSubscriptions.userId,
  endpoint: pushSubscriptions.endpoint,
  p256dh: pushSubscriptions.p256dh,
  auth: pushSubscriptions.auth,
};

/** Subscriptions whose session is still signed in and whose key is current. */
function deliverable(currentPublicKey: string) {
  return and(
    eq(pushSubscriptions.applicationServerKey, currentPublicKey),
    gt(session.expiresAt, sql`now()`),
  );
}

export async function listDeliverableSubscriptions(
  userIds: string[],
  currentPublicKey: string,
): Promise<DeliverablePushSubscription[]> {
  if (userIds.length === 0) return [];
  return db
    .select(deliverableColumns)
    .from(pushSubscriptions)
    .innerJoin(session, eq(session.id, pushSubscriptions.sessionId))
    .where(and(inArray(pushSubscriptions.userId, userIds), deliverable(currentPublicKey)));
}

export async function loadDeliverableSubscription(
  subscriptionId: string,
  currentPublicKey: string,
): Promise<DeliverablePushSubscription | null> {
  const [row] = await db
    .select(deliverableColumns)
    .from(pushSubscriptions)
    .innerJoin(session, eq(session.id, pushSubscriptions.sessionId))
    .where(and(eq(pushSubscriptions.id, subscriptionId), deliverable(currentPublicKey)))
    .limit(1);
  return row ?? null;
}

export async function markPushDelivered(subscriptionId: string) {
  await db
    .update(pushSubscriptions)
    .set({ lastSuccessAt: new Date(), failureCount: 0 })
    .where(eq(pushSubscriptions.id, subscriptionId));
}

/** Consecutive rejected deliveries after which a device is dropped. */
export const MAX_PUSH_FAILURES = 10;

export async function markPushRejected(subscriptionId: string) {
  const [row] = await db
    .update(pushSubscriptions)
    .set({ failureCount: sql`${pushSubscriptions.failureCount} + 1` })
    .where(eq(pushSubscriptions.id, subscriptionId))
    .returning({ failureCount: pushSubscriptions.failureCount });
  if (row && row.failureCount >= MAX_PUSH_FAILURES) await deletePushSubscription(subscriptionId);
}

export async function deletePushSubscription(subscriptionId: string) {
  await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, subscriptionId));
}
