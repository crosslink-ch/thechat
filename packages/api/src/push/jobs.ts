import crypto from "node:crypto";
import { db } from "../db";
import { PgBossAsyncBus } from "../async/pg-boss";
import { QUEUES, type Executor } from "../async/queue";
import { AsyncWorkerRuntime } from "../async/worker";
import type {
  AsyncJobHandler,
  AsyncMessage,
  QueueCommand,
  QueuedJob,
} from "../async/types";
import { log } from "../logging";
import { webPushConfig } from "./config";
import {
  agentRunInProgress,
  buildPushPayload,
  planBotRequestRecipients,
  planMessageRecipients,
  type PlannedRecipient,
  type PushSource,
} from "./content";
import { pushServiceHost } from "./endpoint";
import { pushTopic, sendWebPush } from "./sender";
import {
  deletePushSubscription,
  listDeliverableSubscriptions,
  loadDeliverableSubscription,
  markPushDelivered,
  markPushRejected,
} from "./subscriptions";

export const PUSH_QUEUE_NAME = QUEUES.push;
export const PUSH_FANOUT_JOB_NAME = "push.fanout";
export const PUSH_DELIVER_JOB_NAME = "push.deliver";

const pushLog = log.child({ component: "web-push" });

interface FanoutPayload {
  source: PushSource;
}

interface DeliverPayload {
  source: PushSource;
  subscriptionId: string;
  userId: string;
}

export class RetryablePushError extends Error {
  constructor(status: number | null) {
    super(`Push service asked to retry${status ? ` (HTTP ${status})` : ""}`);
    this.name = "RetryablePushError";
  }
}

/** Where push jobs go: the pg-boss `push.notification` queue in production. */
export interface PushBus {
  enqueue<T>(command: QueueCommand<T>, executor: Executor): Promise<QueuedJob>;
}

let bus: PushBus | null = null;
let worker: AsyncWorkerRuntime | null = null;

function getPushBus(): PushBus {
  bus ??= new PgBossAsyncBus(QUEUES.push);
  return bus;
}

export function setPushBusForTests(next: PushBus | null) {
  bus = next;
}

export function sourceKey(source: PushSource): string {
  switch (source.type) {
    case "message":
      return `message:${source.messageId}`;
    case "bot_request":
      return `request:${source.requestId}`;
    case "test":
      return `test:${source.nonce}`;
  }
}

function asyncMessage<T>(
  type: string,
  aggregateId: string,
  payload: T,
): AsyncMessage<T> {
  return {
    id: crypto.randomUUID(),
    type,
    version: 1,
    aggregate: { type: "push_notification", id: aggregateId },
    correlationId: aggregateId,
    occurredAt: new Date().toISOString(),
    payload,
  };
}

/** How often, and how long, to wait for an agent run to finish before notifying. */
export const AGENT_RUN_WAIT_MS = 5_000;
export const MAX_AGENT_RUN_WAITS = 120; // 10 minutes, then notify anyway

function fanoutJobId(source: PushSource) {
  const round = source.type === "message" ? source.waitRound ?? 0 : 0;
  return `push-fanout:${sourceKey(source)}${round > 0 ? `:wait${round}` : ""}`;
}

async function enqueueFanout(source: PushSource, delayMs: number) {
  const key = sourceKey(source);
  await getPushBus().enqueue<FanoutPayload>({
    queue: PUSH_QUEUE_NAME,
    name: PUSH_FANOUT_JOB_NAME,
    jobId: fanoutJobId(source),
    message: asyncMessage(PUSH_FANOUT_JOB_NAME, key, { source }),
    attempts: 5,
    backoff: { type: "exponential", delay: 2_000 },
    delayMs,
  }, db);
}

/**
 * Queue a notification for later fan-out. Idempotent per source, so a
 * redelivered or replayed event never notifies twice. A no-op when Web Push is
 * not configured.
 */
export async function schedulePushNotifications(source: PushSource) {
  const config = webPushConfig();
  if (!config) return;
  await enqueueFanout(source, config.delayMs);
}

/** Never let a notification problem fail the action that triggered it. */
export async function schedulePushNotificationsSafely(source: PushSource) {
  try {
    await schedulePushNotifications(source);
  } catch (error) {
    pushLog.warn(
      { err: error, source: source.type },
      "Failed to schedule push notification",
    );
  }
}

async function planRecipients(source: PushSource): Promise<PlannedRecipient[]> {
  switch (source.type) {
    case "message":
      return planMessageRecipients(source.messageId, source.invocationId);
    case "bot_request":
      return planBotRequestRecipients(source.requestId);
    case "test":
      return [];
  }
}

export function createPushFanoutHandler(): AsyncJobHandler<FanoutPayload> {
  return {
    queue: PUSH_QUEUE_NAME,
    name: PUSH_FANOUT_JOB_NAME,
    async handle(job) {
      const config = webPushConfig();
      if (!config) return { recipients: 0, deliveries: 0 };
      const { source } = job.message.payload;
      // An agent's interim messages ("Looking into it…") wait for its run to
      // end; then only the newest message of the run notifies (see content.ts).
      if (
        source.type === "message" &&
        source.invocationId &&
        (source.waitRound ?? 0) < MAX_AGENT_RUN_WAITS &&
        (await agentRunInProgress(source.invocationId))
      ) {
        await enqueueFanout({ ...source, waitRound: (source.waitRound ?? 0) + 1 }, AGENT_RUN_WAIT_MS);
        return { recipients: 0, deliveries: 0, waiting: true };
      }
      const recipients = await planRecipients(source);
      const subscriptions = await listDeliverableSubscriptions(
        recipients.map((recipient) => recipient.userId),
        config.publicKey,
      );
      const key = sourceKey(source);
      for (const subscription of subscriptions) {
        await getPushBus().enqueue<DeliverPayload>({
          queue: PUSH_QUEUE_NAME,
          name: PUSH_DELIVER_JOB_NAME,
          jobId: `push-deliver:${key}:${subscription.id}`,
          message: asyncMessage(PUSH_DELIVER_JOB_NAME, key, {
            source,
            subscriptionId: subscription.id,
            userId: subscription.userId,
          }),
          attempts: 6,
          backoff: { type: "exponential", delay: 5_000 },
        }, db);
      }
      return { recipients: recipients.length, deliveries: subscriptions.length };
    },
  };
}

export type PushDeliveryResult =
  | { status: "skipped"; reason: string }
  | { status: "accepted" | "gone" | "rejected"; httpStatus: number };

/**
 * Send one notification to one device. Content, access and preferences are
 * re-checked now, not when the event was queued.
 */
export async function deliverPushNotification(
  input: DeliverPayload,
): Promise<PushDeliveryResult> {
  const config = webPushConfig();
  if (!config) return { status: "skipped", reason: "not_configured" };
  const subscription = await loadDeliverableSubscription(
    input.subscriptionId,
    config.publicKey,
  );
  // Logged out, expired, or the browser moved to another account.
  if (!subscription || subscription.userId !== input.userId) {
    return { status: "skipped", reason: "subscription_inactive" };
  }
  const payload = await buildPushPayload(input.source, input.userId);
  if (!payload) return { status: "skipped", reason: "nothing_to_send" };

  const outcome = await sendWebPush(subscription, payload, config, {
    urgency: payload.kind === "test" ? "normal" : "high",
    topic: pushTopic(payload.tag),
  });
  const host = pushServiceHost(subscription.endpoint);
  switch (outcome.kind) {
    case "accepted":
      await markPushDelivered(subscription.id);
      return { status: "accepted", httpStatus: outcome.status };
    case "gone":
      await deletePushSubscription(subscription.id);
      pushLog.info({ host, status: outcome.status }, "Removed expired push subscription");
      return { status: "gone", httpStatus: outcome.status };
    case "rejected":
      await markPushRejected(subscription.id);
      pushLog.warn({ host, status: outcome.status }, "Push service rejected a notification");
      return { status: "rejected", httpStatus: outcome.status };
    case "retry":
      pushLog.warn({ host, status: outcome.status }, "Push service unavailable; will retry");
      throw new RetryablePushError(outcome.status);
  }
}

export function createPushDeliverHandler(): AsyncJobHandler<DeliverPayload> {
  return {
    queue: PUSH_QUEUE_NAME,
    name: PUSH_DELIVER_JOB_NAME,
    handle: (job) => deliverPushNotification(job.message.payload),
  };
}

export async function startPushWorker(
  options: { concurrency?: number } = {},
): Promise<AsyncWorkerRuntime | null> {
  if (worker) return worker;
  if (!webPushConfig()) {
    pushLog.info("Web Push is not configured; background notifications are off");
    return null;
  }
  const runtime = new AsyncWorkerRuntime({
    queue: QUEUES.push,
    concurrency: options.concurrency,
  });
  runtime.register(createPushFanoutHandler());
  runtime.register(createPushDeliverHandler());
  await runtime.start([PUSH_QUEUE_NAME]);
  worker = runtime;
  pushLog.info("Web Push worker is listening");
  return runtime;
}

export async function closePushRuntime() {
  const current = worker;
  worker = null;
  bus = null;
  await current?.close();
}
