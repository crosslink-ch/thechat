import crypto from "crypto";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { SpanStatusCode } from "@opentelemetry/api";
import type {
  BotInvocationPublic,
  BotInvocationProgressEventPublic,
  BotRuntimeSnapshot,
  ChatMessage,
  WebhookPayload,
  WsServerEvent,
} from "@thechat/shared";
import { BullMqAsyncBus } from "../async";
import { AsyncWorkerRuntime } from "../async/worker";
import type { AsyncJobHandler, QueueCommand } from "../async/types";
import { db } from "../db";
import {
  botInvocations,
  bots,
  conversationParticipants,
  conversationThreads,
  conversations,
  hermesBotConfigs,
  messages,
  users,
  workspaces,
} from "../db/schema";
import { publishWsEventToUsers } from "../realtime";
import { stripBotMention } from "./hermes";
import { ServiceError } from "./errors";
import { withSpan } from "../observability";
import { getBotProgressStore } from "./bot-progress-store";

export const BOT_QUEUE_NAME = "thechat:bots";
export const BOT_INVOKE_JOB_NAME = "bot.invoke";
export const HERMES_WEBHOOK_DELIVERY_JOB_NAME = "bot.hermes_webhook.deliver";

type BotKind = "webhook" | "hermes";
type ConversationType = "direct" | "group";
type BotInvocationStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

interface TriggerMessage {
  id: string;
  content: string;
  conversationId: string;
  threadId: string | null;
  senderId: string;
  senderName: string;
  createdAt: string;
}

interface TriggeredBot {
  botId: string;
  botUserId: string;
  kind: BotKind;
  webhookUrl: string | null;
  webhookSecret: string;
  botName: string;
}

interface ConversationRow {
  id: string;
  type: ConversationType;
  name: string | null;
  workspaceId: string | null;
}

interface BotInvokePayload {
  invocationId: string;
}

interface HermesWebhookDeliveryPayload {
  invocationId: string;
}

interface HermesPlatformProgressInput {
  authenticatedBotId: string;
  invocationId: string;
  botId?: string;
  conversationId?: string;
  type: string;
  status?: string | null;
  toolCallId?: string | null;
  toolName?: string | null;
  label?: string | null;
  preview?: string | null;
  payload?: Record<string, unknown> | null;
  occurredAt?: Date | null;
}

type HermesPlatformDeliveryMode = "polling" | "webhook";

interface HermesPlatformMessageTarget {
  invocation: typeof botInvocations.$inferSelect | null;
  bot: typeof bots.$inferSelect;
  botName: string;
  conversation: typeof conversations.$inferSelect;
  threadId: string | null;
}

let asyncBus: BullMqAsyncBus | null = null;
let botWorker: AsyncWorkerRuntime | null = null;
let botWorkerStartPromise: Promise<AsyncWorkerRuntime> | null = null;

function recordFromJson(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

export function signWebhookPayload(body: string, secret: string, timestamp: number): string {
  const signedContent = `${timestamp}.${body}`;
  return crypto.createHmac("sha256", secret).update(signedContent).digest("hex");
}

export async function processMessageMentions(msg: TriggerMessage) {
  await withSpan(
    "bot.invocation.detect",
    {
      "messaging.conversation_id": msg.conversationId,
      "messaging.message_id": msg.id,
    },
    async () => {
      const participants = await db
        .select({ userId: conversationParticipants.userId })
        .from(conversationParticipants)
        .where(eq(conversationParticipants.conversationId, msg.conversationId));

      const participantIds = participants.map((p) => p.userId);
      if (participantIds.length === 0) return;

      const botRows = await db
        .select({
          botId: bots.id,
          botUserId: bots.userId,
          kind: bots.kind,
          webhookUrl: bots.webhookUrl,
          webhookSecret: bots.webhookSecret,
          botName: users.name,
        })
        .from(bots)
        .innerJoin(users, eq(bots.userId, users.id));

      const participantBots = botRows.filter((b) => participantIds.includes(b.botUserId));
      if (participantBots.length === 0) return;
      const senderIsBot = participantBots.some((b) => b.botUserId === msg.senderId);

      const [conv] = await db
        .select({
          id: conversations.id,
          type: conversations.type,
          name: conversations.name,
          workspaceId: conversations.workspaceId,
        })
        .from(conversations)
        .where(eq(conversations.id, msg.conversationId))
        .limit(1);

      if (!conv) return;

      const triggeredBots = participantBots.filter((b) => {
        if (b.botUserId === msg.senderId) return false;
        if (b.kind === "webhook" && !b.webhookUrl) return false;
        const escaped = b.botName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const regex = new RegExp(`@${escaped}\\b`, "i");
        const isMentioned = regex.test(msg.content);
        const isDirectHermesDm = !senderIsBot && conv.type === "direct" && b.kind === "hermes";
        return isMentioned || isDirectHermesDm;
      });

      for (const bot of triggeredBots) {
        await enqueueBotInvocation({ bot, conversation: conv, message: msg });
      }
    },
  );
}

export async function listConversationBotRuntime(conversationId: string, userId: string): Promise<BotRuntimeSnapshot> {
  return withSpan(
    "bot.runtime.list",
    {
      "messaging.system": "thechat",
      "thechat.conversation_id": conversationId,
    },
    async (span) => {
      await requireConversationParticipant(conversationId, userId);

      const activeInvocationRows = await db
        .select({
          id: botInvocations.id,
          botId: botInvocations.botId,
          botUserId: bots.userId,
          botName: users.name,
          botKind: bots.kind,
          conversationId: botInvocations.conversationId,
          threadId: botInvocations.threadId,
          triggerMessageId: botInvocations.triggerMessageId,
          responseMessageId: botInvocations.responseMessageId,
          adapterKind: botInvocations.adapterKind,
          status: botInvocations.status,
          externalRunId: botInvocations.externalRunId,
          requestJson: botInvocations.requestJson,
          responseJson: botInvocations.responseJson,
          error: botInvocations.error,
          startedAt: botInvocations.startedAt,
          completedAt: botInvocations.completedAt,
          createdAt: botInvocations.createdAt,
          updatedAt: botInvocations.updatedAt,
        })
        .from(botInvocations)
        .innerJoin(bots, eq(botInvocations.botId, bots.id))
        .innerJoin(users, eq(bots.userId, users.id))
        .where(
          and(
            eq(botInvocations.conversationId, conversationId),
            inArray(botInvocations.status, ["queued", "running"]),
          ),
        )
        .orderBy(desc(botInvocations.createdAt));

      const events = await getBotProgressStore().listForInvocations(
        activeInvocationRows.map((invocation) => invocation.id),
      );

      span.setAttribute("thechat.bot_runtime.active_invocations", activeInvocationRows.length);
      span.setAttribute("thechat.bot_runtime.progress_events", events.length);

      return {
        invocations: activeInvocationRows.map(toPublicInvocation),
        events,
      };
    },
  );
}

export async function startBotWorker(options: { concurrency?: number } = {}): Promise<AsyncWorkerRuntime> {
  if (botWorkerStartPromise) return botWorkerStartPromise;
  botWorkerStartPromise = (async () => {
    const runtime = new AsyncWorkerRuntime({ concurrency: options.concurrency });
    runtime.register(createBotInvokeHandler());
    runtime.register(createHermesWebhookDeliveryHandler());
    await runtime.start([BOT_QUEUE_NAME]);
    botWorker = runtime;
    return runtime;
  })();
  return botWorkerStartPromise;
}

export async function closeBotRuntimeForTests(): Promise<void> {
  await closeBotRuntime();
}

export async function closeBotRuntime(): Promise<void> {
  await Promise.allSettled([asyncBus?.close(), botWorker?.close(true)]);
  asyncBus = null;
  botWorker = null;
  botWorkerStartPromise = null;
}

function createBotInvokeHandler(): AsyncJobHandler<BotInvokePayload> {
  return {
    queue: BOT_QUEUE_NAME,
    name: BOT_INVOKE_JOB_NAME,
    async handle(job, context) {
      await context.setProgress(5, { invocationId: job.message.payload.invocationId });
      await handleQueuedBotInvocation(job.message.payload.invocationId, context);
      await context.setProgress(100, { invocationId: job.message.payload.invocationId });
    },
  };
}

function createHermesWebhookDeliveryHandler(): AsyncJobHandler<HermesWebhookDeliveryPayload> {
  return {
    queue: BOT_QUEUE_NAME,
    name: HERMES_WEBHOOK_DELIVERY_JOB_NAME,
    async handle(job, context) {
      const { invocationId } = job.message.payload;
      await context.setProgress(5, { invocationId });
      const isFinalAttempt = job.attemptsMade + 1 >= job.maxAttempts;
      await deliverHermesPlatformWebhookInvocation(invocationId, { failOnError: isFinalAttempt });
      await context.setProgress(100, { invocationId });
    },
  };
}

async function enqueueBotInvocation(input: {
  bot: TriggeredBot;
  conversation: ConversationRow;
  message: TriggerMessage;
}) {
  const invocation = await getOrCreateInvocation(input.bot, input.conversation, input.message);
  await publishInvocationUpdate(invocation.id);

  if (input.bot.kind === "hermes") {
    if (invocation.status === "queued" && input.bot.webhookUrl) {
      const command = createHermesWebhookDeliveryCommand(
        invocation.id,
        input.conversation.workspaceId,
        input.message.id,
      );
      await getAsyncBus().enqueue(command);
    }
    return;
  }

  const command = createBotInvokeCommand(invocation.id, input.conversation.workspaceId, input.message.id);
  await getAsyncBus().enqueue(command);
}

async function getOrCreateInvocation(
  bot: TriggeredBot,
  conversation: ConversationRow,
  message: TriggerMessage,
) {
  const inserted = await db
    .insert(botInvocations)
    .values({
      botId: bot.botId,
      conversationId: conversation.id,
      threadId: message.threadId,
      triggerMessageId: message.id,
      adapterKind: bot.kind,
      status: "queued",
      requestJson: {
        messageId: message.id,
        threadId: message.threadId,
        messageContent: message.content,
        triggeredAt: new Date().toISOString(),
      },
    })
    .onConflictDoNothing({
      target: [botInvocations.botId, botInvocations.triggerMessageId],
    })
    .returning();

  if (inserted[0]) return inserted[0];

  const [existing] = await db
    .select()
    .from(botInvocations)
    .where(and(eq(botInvocations.botId, bot.botId), eq(botInvocations.triggerMessageId, message.id)))
    .limit(1);
  if (!existing) throw new Error("Failed to create bot invocation");
  return existing;
}

function createBotInvokeCommand(
  invocationId: string,
  workspaceId: string | null,
  triggerMessageId: string,
): QueueCommand<BotInvokePayload> {
  return {
    queue: BOT_QUEUE_NAME,
    name: BOT_INVOKE_JOB_NAME,
    jobId: `bot:invoke:${invocationId}`,
    attempts: 3,
    backoff: { type: "exponential", delay: 2_000 },
    removeOnComplete: { age: 7 * 24 * 60 * 60, count: 10_000 },
    removeOnFail: false,
    message: {
      id: crypto.randomUUID(),
      type: "bot.invoke.requested",
      version: 1,
      aggregate: { type: "bot_invocation", id: invocationId },
      actor: { type: "system", id: "thechat" },
      tenant: workspaceId ? { workspaceId } : undefined,
      correlationId: triggerMessageId,
      causationId: triggerMessageId,
      idempotencyKey: `bot-invocation:${invocationId}`,
      occurredAt: new Date().toISOString(),
      payload: { invocationId },
    },
  };
}

function createHermesWebhookDeliveryCommand(
  invocationId: string,
  workspaceId: string | null,
  triggerMessageId: string,
): QueueCommand<HermesWebhookDeliveryPayload> {
  return {
    queue: BOT_QUEUE_NAME,
    name: HERMES_WEBHOOK_DELIVERY_JOB_NAME,
    jobId: `bot:hermes-webhook:${invocationId}`,
    attempts: 3,
    backoff: { type: "exponential", delay: 2_000 },
    removeOnComplete: { age: 7 * 24 * 60 * 60, count: 10_000 },
    removeOnFail: false,
    message: {
      id: crypto.randomUUID(),
      type: "bot.hermes_webhook_delivery.requested",
      version: 1,
      aggregate: { type: "bot_invocation", id: invocationId },
      actor: { type: "system", id: "thechat" },
      tenant: workspaceId ? { workspaceId } : undefined,
      correlationId: triggerMessageId,
      causationId: triggerMessageId,
      idempotencyKey: `bot-hermes-webhook-delivery:${invocationId}`,
      occurredAt: new Date().toISOString(),
      payload: { invocationId },
    },
  };
}

async function handleQueuedBotInvocation(invocationId: string, context: { setProgress(progress: number, detail?: unknown): Promise<void> }) {
  const loaded = await loadInvocationContext(invocationId);
  if (!loaded) {
    await context.setProgress(100, { status: "missing" });
    return;
  }
  if (loaded.invocation.status === "completed") return;
  if (loaded.invocation.status === "running" && loaded.invocation.startedAt) {
    const ageMs = Date.now() - loaded.invocation.startedAt.getTime();
    if (ageMs < 10 * 60 * 1000) return;
  }

  await markInvocationStatus(invocationId, "running", { startedAt: new Date(), error: null });
  await publishInvocationUpdate(invocationId);
  await context.setProgress(15, { status: "running" });

  try {
    if (loaded.bot.kind === "hermes") {
      await context.setProgress(100, { status: "claimed_by_hermes_platform" });
    } else {
      await handleWebhookInvocation(invocationId);
    }
  } catch (error: any) {
    await failInvocation(invocationId, error);
    throw error;
  }
}

async function handleWebhookInvocation(invocationId: string) {
  const loaded = await loadInvocationContext(invocationId);
  if (!loaded) throw new Error(`Bot invocation not found: ${invocationId}`);
  if (!loaded.bot.webhookUrl) throw new Error("Webhook bot does not have a webhook URL");

  const workspace = loaded.conversation.workspaceId
    ? await db
        .select({ id: workspaces.id, name: workspaces.name })
        .from(workspaces)
        .where(eq(workspaces.id, loaded.conversation.workspaceId))
        .limit(1)
        .then((rows) => rows[0] ?? null)
    : null;

  const payload: WebhookPayload = {
    event: "mention",
    message: {
      id: loaded.triggerMessage.id,
      content: loaded.triggerMessage.content,
      conversationId: loaded.triggerMessage.conversationId,
      threadId: loaded.triggerMessage.threadId,
      senderId: loaded.triggerMessage.senderId,
      senderName: loaded.triggerSender.name,
      createdAt: loaded.triggerMessage.createdAt.toISOString(),
    },
    conversation: {
      id: loaded.conversation.id,
      type: loaded.conversation.type,
      name: loaded.conversation.name,
      workspaceId: loaded.conversation.workspaceId,
    },
    workspace,
    bot: { id: loaded.bot.id, name: loaded.botName },
  };

  const body = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = signWebhookPayload(body, loaded.bot.webhookSecret, timestamp);

  const response = await fetch(loaded.bot.webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Webhook-Timestamp": String(timestamp),
      "X-Webhook-Signature": signature,
    },
    body,
  });

  if (!response.ok) {
    throw new Error(`Webhook failed with HTTP ${response.status}`);
  }

  await markInvocationStatus(invocationId, "completed", {
    completedAt: new Date(),
    responseJson: { status: response.status },
  });
  await publishInvocationUpdate(invocationId);
}

export interface HermesPlatformEvent {
  id: string;
  invocationId: string;
  chatId: string;
  chatType: "dm" | "group";
  threadId: string | null;
  text: string;
  messageId: string;
  instructions: string | null;
  sender: { id: string; name: string };
  bot: { id: string; userId: string; name: string };
  conversation: {
    id: string;
    type: ConversationType;
    name: string | null;
    workspaceId: string | null;
  };
}

interface PreparedHermesPlatformEvent {
  event: HermesPlatformEvent;
  requestJson: Record<string, unknown>;
}

async function claimHermesPlatformInvocation(
  invocationId: string,
  deliveryMode: HermesPlatformDeliveryMode = "polling",
): Promise<HermesPlatformEvent | null> {
  const prepared = await prepareHermesPlatformEvent(invocationId, deliveryMode);
  if (!prepared) {
    await failInvocation(invocationId, new Error("Hermes invocation context is incomplete"));
    return null;
  }

  const now = new Date();
  const [claimed] = await db
    .update(botInvocations)
    .set({
      status: "running",
      startedAt: now,
      externalRunId: `thechat:${invocationId}`,
      error: null,
      requestJson: prepared.requestJson,
      updatedAt: now,
    })
    .where(
      and(
        eq(botInvocations.id, invocationId),
        eq(botInvocations.status, "queued"),
        eq(botInvocations.adapterKind, "hermes"),
      ),
    )
    .returning({ id: botInvocations.id });
  if (!claimed) return null;

  await publishInvocationUpdate(invocationId);
  return prepared.event;
}

export async function claimHermesPlatformEvents(botId: string, limit = 10): Promise<HermesPlatformEvent[]> {
  return withSpan(
    "hermes_platform.events.claim",
    {
      "messaging.system": "thechat",
      "messaging.operation": "receive",
      "thechat.bot_id": botId,
    },
    async (span) => {
      const cappedLimit = Math.max(1, Math.min(limit, 50));
      span.setAttribute("thechat.hermes_platform.events.limit", cappedLimit);
      const pending = await db
        .select({ id: botInvocations.id })
        .from(botInvocations)
        .innerJoin(bots, eq(botInvocations.botId, bots.id))
        .where(
          and(
            eq(botInvocations.status, "queued"),
            eq(botInvocations.adapterKind, "hermes"),
            eq(botInvocations.botId, botId),
            eq(bots.kind, "hermes"),
          ),
        )
        .orderBy(asc(botInvocations.createdAt))
        .limit(cappedLimit);

      const events: HermesPlatformEvent[] = [];
      for (const row of pending) {
        const event = await claimHermesPlatformInvocation(row.id, "polling");
        if (event) events.push(event);
      }
      span.setAttribute("thechat.hermes_platform.events.count", events.length);
      return events;
    },
  );
}

async function prepareHermesPlatformEvent(
  invocationId: string,
  deliveryMode: HermesPlatformDeliveryMode,
): Promise<PreparedHermesPlatformEvent | null> {
  const loaded = await loadInvocationContext(invocationId);
  if (!loaded || loaded.bot.kind !== "hermes") return null;

  const [config] = await db
    .select({
      defaultInstructions: hermesBotConfigs.defaultInstructions,
    })
    .from(hermesBotConfigs)
    .where(eq(hermesBotConfigs.botId, loaded.bot.id))
    .limit(1);

  const text = stripBotMention(loaded.triggerMessage.content, loaded.botName) || loaded.triggerMessage.content;
  const chatId = conversationChatId(loaded.conversation);
  const threadId = loaded.invocation.threadId ?? loaded.triggerMessage.threadId ?? null;
  const requestJson = {
    platform: "thechat",
    deliveryMode,
    chatId,
    threadId,
    messageId: loaded.triggerMessage.id,
    messageContent: loaded.triggerMessage.content,
    text,
    triggeredAt: loaded.triggerMessage.createdAt.toISOString(),
  };

  return {
    requestJson,
    event: {
      id: invocationId,
      invocationId,
      chatId,
      chatType: loaded.conversation.type === "direct" ? "dm" : "group",
      threadId,
      text,
      messageId: loaded.triggerMessage.id,
      instructions: config?.defaultInstructions ?? null,
      sender: {
        id: loaded.triggerMessage.senderId,
        name: loaded.triggerSender.name,
      },
      bot: {
        id: loaded.bot.id,
        userId: loaded.bot.userId,
        name: loaded.botName,
      },
      conversation: {
        id: loaded.conversation.id,
        type: loaded.conversation.type,
        name: loaded.conversation.name,
        workspaceId: loaded.conversation.workspaceId,
      },
    },
  };
}

async function deliverHermesPlatformWebhookInvocation(
  invocationId: string,
  options: { failOnError?: boolean } = {},
): Promise<void> {
  await withSpan(
    "hermes_platform.webhook.deliver",
    {
      "messaging.system": "thechat",
      "messaging.destination.kind": "hermes_platform_webhook",
      "thechat.bot_invocation_id": invocationId,
    },
    async (span) => {
      const initial = await loadInvocationContext(invocationId);
      if (!initial || initial.bot.kind !== "hermes") {
        span.setAttribute("thechat.hermes_platform.delivery_status", "skipped");
        return;
      }
      span.setAttribute("thechat.bot_id", initial.bot.id);
      if (initial.invocation.status === "completed" || initial.invocation.status === "cancelled") {
        span.setAttribute("thechat.hermes_platform.delivery_status", "already_finished");
        return;
      }
      if (initial.invocation.status === "failed") {
        span.setAttribute("thechat.hermes_platform.delivery_status", "already_failed");
        return;
      }
      if (
        initial.invocation.status === "running" &&
        getHermesPlatformDeliveryMode(initial.invocation.requestJson) !== "webhook"
      ) {
        span.setAttribute("thechat.hermes_platform.delivery_status", "already_claimed");
        return;
      }
      if (!initial.bot.webhookUrl) {
        const error = new Error("Hermes webhook URL is not configured");
        span.recordException(error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        await failInvocation(invocationId, error);
        span.setAttribute("thechat.hermes_platform.delivery_status", "missing_webhook_url");
        return;
      }

      const event =
        initial.invocation.status === "running"
          ? (await prepareHermesPlatformEvent(invocationId, "webhook"))?.event ?? null
          : await claimHermesPlatformInvocation(invocationId, "webhook");
      if (!event) {
        span.setAttribute("thechat.hermes_platform.delivery_status", "claim_missed");
        return;
      }

      const loaded = await loadInvocationContext(invocationId);
      if (!loaded?.bot.webhookUrl) {
        const error = new Error("Hermes webhook URL is not configured");
        span.recordException(error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        await failInvocation(invocationId, error);
        span.setAttribute("thechat.hermes_platform.delivery_status", "missing_webhook_url");
        return;
      }

      const body = JSON.stringify({ type: "thechat.hermes_platform.event", event });
      try {
        const response = await fetch(loaded.bot.webhookUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${loaded.bot.apiKey}`,
            "X-TheChat-Bot-Id": loaded.bot.id,
            "X-TheChat-Invocation-Id": invocationId,
          },
          body,
        });
        span.setAttribute("http.response.status_code", response.status);
        if (!response.ok) {
          const error = new Error(`Hermes webhook failed with HTTP ${response.status}`);
          span.recordException(error);
          span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
          span.setAttribute("thechat.hermes_platform.delivery_status", "failed");
          throw error;
        }
        span.setAttribute("thechat.hermes_platform.delivery_status", "delivered");
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        span.recordException(failure);
        span.setStatus({ code: SpanStatusCode.ERROR, message: failure.message });
        span.setAttribute("thechat.hermes_platform.delivery_status", "failed");
        if (options.failOnError) await failInvocation(invocationId, failure);
        throw failure;
      }
    },
  );
}

function getHermesPlatformDeliveryMode(requestJson: Record<string, unknown> | null): HermesPlatformDeliveryMode | null {
  const deliveryMode = requestJson?.deliveryMode;
  return deliveryMode === "polling" || deliveryMode === "webhook" ? deliveryMode : null;
}

function conversationChatId(conversation: { id: string }) {
  return conversation.id;
}

function conversationIdFromHermesChatId(chatId: string | null | undefined): string | null {
  if (!chatId) return null;
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (uuidPattern.test(chatId)) return chatId;
  const match = chatId.match(/(?:^|:)conversation:([^:]+)/);
  return match?.[1] ?? null;
}

async function resolveHermesPlatformMessageTarget(input: {
  authenticatedBotId: string;
  invocationId?: string | null;
  botId?: string;
  conversationId?: string;
  chatId?: string | null;
  threadId?: string | null;
}): Promise<HermesPlatformMessageTarget> {
  if (input.invocationId) {
    const loaded = await loadInvocationContext(input.invocationId);
    if (!loaded) throw new ServiceError("Invocation not found", 404);
    if (loaded.bot.kind !== "hermes") throw new ServiceError("Invocation is not for a Hermes bot", 400);
    if (loaded.bot.id !== input.authenticatedBotId) throw new ServiceError("Bot token does not match invocation", 403);
    if (input.botId && input.botId !== loaded.bot.id) throw new ServiceError("Bot does not match invocation", 400);
    if (input.conversationId && input.conversationId !== loaded.conversation.id) {
      throw new ServiceError("Conversation does not match invocation", 400);
    }
    return {
      invocation: loaded.invocation,
      bot: loaded.bot,
      botName: loaded.botName,
      conversation: loaded.conversation,
      threadId: loaded.invocation.threadId ?? null,
    };
  }

  if (input.botId && input.botId !== input.authenticatedBotId) {
    throw new ServiceError("Bot token does not match bot", 403);
  }

  const [botRow] = await db
    .select({
      bot: bots,
      botName: users.name,
    })
    .from(bots)
    .innerJoin(users, eq(bots.userId, users.id))
    .where(eq(bots.id, input.authenticatedBotId))
    .limit(1);
  if (!botRow || botRow.bot.kind !== "hermes") throw new ServiceError("Bot token is not for a Hermes bot", 403);

  let conversationId = input.conversationId ?? conversationIdFromHermesChatId(input.chatId);
  if (!conversationId) throw new ServiceError("conversationId or resolvable chatId is required", 400);

  const [conversation] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);
  if (!conversation) throw new ServiceError("Conversation not found", 404);

  const [participant] = await db
    .select({ userId: conversationParticipants.userId })
    .from(conversationParticipants)
    .where(
      and(
        eq(conversationParticipants.conversationId, conversation.id),
        eq(conversationParticipants.userId, botRow.bot.userId),
      ),
    )
    .limit(1);
  if (!participant) throw new ServiceError("Bot is not a participant of this conversation", 403);
  const threadId = input.threadId ?? null;
  if (threadId) await requireConversationThread(conversation.id, threadId);

  return {
    invocation: null,
    bot: botRow.bot,
    botName: botRow.botName,
    conversation,
    threadId,
  };
}

export async function publishHermesPlatformMessage(input: {
  authenticatedBotId: string;
  invocationId?: string | null;
  content: string;
  platformMessageId?: string | null;
  botId?: string;
  conversationId?: string;
  chatId?: string | null;
  threadId?: string | null;
  complete?: boolean;
}) {
  return withSpan(
    "hermes_platform.message.record",
    {
      "messaging.system": "thechat",
      "messaging.operation": "hermes_message",
      "thechat.bot_invocation_id": input.invocationId ?? "",
      "thechat.bot_id": input.botId ?? input.authenticatedBotId,
      "thechat.conversation_id": input.conversationId ?? "",
      "thechat.hermes_platform.message.has_invocation": Boolean(input.invocationId),
      "thechat.hermes_platform.message.complete": Boolean(input.invocationId && input.complete === true),
    },
    async (span) => {
      const content = input.content.trim();
      if (!content) throw new ServiceError("Message content is required", 400);

      const target = await resolveHermesPlatformMessageTarget(input);
      const shouldComplete = Boolean(target.invocation && input.complete === true);
      const previousResponseJson = recordFromJson(target.invocation?.responseJson);
      const previousPlatformMessageId = previousResponseJson.platformMessageId;
      if (target.invocation) {
        span.setAttribute("thechat.bot_invocation.status.previous", target.invocation.status);
      }
      span.setAttribute("thechat.conversation_id", target.conversation.id);
      span.setAttribute("thechat.bot_id", target.bot.id);
      span.setAttribute(
        "thechat.hermes_platform.message.has_previous_response",
        Boolean(target.invocation?.responseMessageId),
      );

      if (
        shouldComplete &&
        target.invocation?.status === "completed" &&
        target.invocation.responseMessageId &&
        input.platformMessageId &&
        previousPlatformMessageId === input.platformMessageId
      ) {
        span.setAttribute("thechat.hermes_platform.message.duplicate", true);
        return {
          messageId: target.invocation.responseMessageId,
          threadId: target.threadId,
          duplicate: true,
        };
      }

      const [responseMessage] = await db
        .insert(messages)
        .values({
          conversationId: target.conversation.id,
          threadId: target.threadId,
          senderId: target.bot.userId,
          content,
          parts: [{ type: "text", text: content }],
        })
        .returning();

      const now = new Date();
      if (target.invocation) {
        await db
          .update(botInvocations)
          .set({
            ...(shouldComplete
              ? { status: "completed", completedAt: now, error: null }
              : {}),
            responseMessageId: responseMessage.id,
            responseJson: {
              ...previousResponseJson,
              platform: "thechat",
              platformMessageId: input.platformMessageId ?? null,
              output: content,
            },
            updatedAt: now,
          })
          .where(eq(botInvocations.id, target.invocation.id));
      }
      if (target.threadId) {
        await db
          .update(conversationThreads)
          .set({ lastActivityAt: responseMessage.createdAt, updatedAt: responseMessage.createdAt })
          .where(eq(conversationThreads.id, target.threadId));
      }

      span.setAttribute("thechat.message_id", responseMessage.id);
      if (target.invocation) {
        span.setAttribute(
          "thechat.bot_invocation.status.next",
          shouldComplete ? "completed" : target.invocation.status,
        );
      }
      await publishBotMessage(responseMessage, target.botName, target.conversation.type);
      processMessageMentions({
        id: responseMessage.id,
        content: responseMessage.content,
        conversationId: responseMessage.conversationId,
        threadId: responseMessage.threadId,
        senderId: responseMessage.senderId,
        senderName: target.botName,
        createdAt: responseMessage.createdAt.toISOString(),
      }).catch((error) => console.error("Failed to enqueue bot invocation from bot message", error));
      if (target.invocation) await publishInvocationUpdate(target.invocation.id);
      return { messageId: responseMessage.id, threadId: responseMessage.threadId, duplicate: false };
    },
  );
}

export async function completeHermesPlatformInvocationSilently(input: {
  authenticatedBotId: string;
  invocationId: string;
  reason?: string | null;
}) {
  return withSpan(
    "hermes_platform.invocation.complete",
    {
      "messaging.system": "thechat",
      "messaging.operation": "hermes_complete",
      "thechat.bot_invocation_id": input.invocationId,
    },
    async (span) => {
      const loaded = await loadInvocationContext(input.invocationId);
      if (!loaded) throw new ServiceError("Invocation not found", 404);
      if (loaded.bot.kind !== "hermes") throw new ServiceError("Invocation is not for a Hermes bot", 400);
      if (loaded.bot.id !== input.authenticatedBotId) throw new ServiceError("Bot token does not match invocation", 403);

      span.setAttribute("thechat.bot_invocation.status.previous", loaded.invocation.status);
      if (loaded.invocation.status === "completed") {
        span.setAttribute("thechat.hermes_platform.complete.duplicate", true);
        return { ok: true, duplicate: true };
      }

      const previousResponseJson = recordFromJson(loaded.invocation.responseJson);
      const hasPriorResponse = Object.keys(previousResponseJson).length > 0;
      const completedAt = new Date();
      await db
        .update(botInvocations)
        .set({
          status: "completed",
          responseJson: hasPriorResponse
            ? {
                ...previousResponseJson,
                completion: {
                  type: "silent",
                  reason: input.reason ?? null,
                },
              }
            : {
                platform: "thechat",
                output: null,
                silent: true,
                reason: input.reason ?? null,
              },
          error: null,
          completedAt,
          updatedAt: completedAt,
        })
        .where(eq(botInvocations.id, input.invocationId));

      await publishInvocationUpdate(input.invocationId);
      return { ok: true, duplicate: false };
    },
  );
}

export async function failHermesPlatformInvocation(input: {
  authenticatedBotId: string;
  invocationId: string;
  error: string;
}) {
  const loaded = await loadInvocationContext(input.invocationId);
  if (!loaded) throw new ServiceError("Invocation not found", 404);
  if (loaded.bot.kind !== "hermes") throw new ServiceError("Invocation is not for a Hermes bot", 400);
  if (loaded.bot.id !== input.authenticatedBotId) throw new ServiceError("Bot token does not match invocation", 403);
  await failInvocation(input.invocationId, new Error(input.error));
  return { ok: true };
}

export async function cancelHermesPlatformInvocation(input: {
  authenticatedBotId: string;
  invocationId: string;
  reason?: string | null;
}) {
  const loaded = await loadInvocationContext(input.invocationId);
  if (!loaded) throw new ServiceError("Invocation not found", 404);
  if (loaded.bot.kind !== "hermes") throw new ServiceError("Invocation is not for a Hermes bot", 400);
  if (loaded.bot.id !== input.authenticatedBotId) throw new ServiceError("Bot token does not match invocation", 403);

  if (loaded.invocation.status === "completed" || loaded.invocation.status === "cancelled") {
    return { ok: true, duplicate: true };
  }

  const reason = input.reason?.trim() || "Hermes gateway cancelled the message";
  const cancelledAt = new Date();
  await db
    .update(botInvocations)
    .set({
      status: "cancelled",
      responseJson: {
        platform: "thechat",
        cancelled: true,
        reason,
      },
      error: reason,
      completedAt: cancelledAt,
      updatedAt: cancelledAt,
    })
    .where(eq(botInvocations.id, input.invocationId));

  await publishInvocationUpdate(input.invocationId);
  return { ok: true, duplicate: false };
}

export async function publishHermesPlatformTyping(input: {
  authenticatedBotId: string;
  invocationId: string;
  botId?: string;
  conversationId?: string;
  threadId?: string | null;
}) {
  const loaded = await loadInvocationContext(input.invocationId);
  if (!loaded) throw new ServiceError("Invocation not found", 404);
  if (loaded.bot.kind !== "hermes") throw new ServiceError("Invocation is not for a Hermes bot", 400);
  if (loaded.bot.id !== input.authenticatedBotId) throw new ServiceError("Bot token does not match invocation", 403);
  if (input.botId && input.botId !== loaded.bot.id) throw new ServiceError("Bot does not match invocation", 400);
  if (input.conversationId && input.conversationId !== loaded.conversation.id) {
    throw new ServiceError("Conversation does not match invocation", 400);
  }
  const threadId = loaded.invocation.threadId ?? loaded.triggerMessage.threadId ?? null;
  if (input.threadId && input.threadId !== threadId) {
    throw new ServiceError("Thread does not match invocation", 400);
  }

  const participantRows = await db
    .select({ userId: conversationParticipants.userId })
    .from(conversationParticipants)
    .where(eq(conversationParticipants.conversationId, loaded.conversation.id));
  await publishWsEventToUsers(participantRows.map((p) => p.userId), {
    type: "typing",
    conversationId: loaded.conversation.id,
    threadId,
    userId: loaded.bot.userId,
    userName: loaded.botName,
  });
  return { ok: true };
}

export async function publishHermesPlatformProgress(
  input: HermesPlatformProgressInput,
): Promise<{ ok: true; event: BotInvocationProgressEventPublic }> {
  return withSpan(
    "hermes_platform.progress.record",
    {
      "messaging.system": "thechat",
      "messaging.operation": "hermes_progress",
      "thechat.bot_invocation_id": input.invocationId,
      "thechat.hermes_progress.type": input.type,
      "thechat.hermes_progress.tool": input.toolName ?? "",
    },
    async (span) => {
      const loaded = await loadInvocationContext(input.invocationId);
      if (!loaded) throw new ServiceError("Invocation not found", 404);
      if (loaded.bot.kind !== "hermes") throw new ServiceError("Invocation is not for a Hermes bot", 400);
      if (loaded.bot.id !== input.authenticatedBotId) throw new ServiceError("Bot token does not match invocation", 403);
      if (input.botId && input.botId !== loaded.bot.id) throw new ServiceError("Bot does not match invocation", 400);
      if (input.conversationId && input.conversationId !== loaded.conversation.id) {
        throw new ServiceError("Conversation does not match invocation", 400);
      }

      const participantRows = await db
        .select({ userId: conversationParticipants.userId })
        .from(conversationParticipants)
        .where(eq(conversationParticipants.conversationId, loaded.conversation.id));

      const event = await getBotProgressStore().append({
        invocationId: loaded.invocation.id,
        botId: loaded.bot.id,
        conversationId: loaded.conversation.id,
        threadId: loaded.invocation.threadId ?? null,
        type: input.type,
        status: input.status ?? null,
        toolCallId: input.toolCallId ?? null,
        toolName: input.toolName ?? null,
        label: input.label ?? null,
        preview: input.preview ?? null,
        payload: input.payload ?? null,
        occurredAt: input.occurredAt ?? new Date(),
      });
      span.setAttribute("thechat.hermes_progress.sequence", event.sequence);
      await publishWsEventToUsers(participantRows.map((p) => p.userId), {
        type: "bot_invocation_progress",
        conversationId: loaded.conversation.id,
        invocationId: loaded.invocation.id,
        event,
      });
      return { ok: true, event };
    },
  );
}

async function failInvocation(invocationId: string, error: any) {
  const message = error?.message ?? String(error);
  const loaded = await loadInvocationContext(invocationId);
  const failedAt = new Date();
  await db
    .update(botInvocations)
    .set({
      status: "failed",
      error: message,
      completedAt: failedAt,
      updatedAt: failedAt,
    })
    .where(eq(botInvocations.id, invocationId));

  if (loaded?.bot.kind === "hermes") {
    const content = `Hermes run failed: ${message}`;
    const [responseMessage] = await db
      .insert(messages)
      .values({
        conversationId: loaded.conversation.id,
        threadId: loaded.invocation.threadId ?? loaded.triggerMessage.threadId,
        senderId: loaded.bot.userId,
        content,
        parts: [{ type: "text", text: content }],
      })
      .returning();
    await db
      .update(botInvocations)
      .set({ responseMessageId: responseMessage.id })
      .where(eq(botInvocations.id, invocationId));
    await publishBotMessage(responseMessage, loaded.botName, loaded.conversation.type);
  }

  await publishInvocationUpdate(invocationId);
}

async function loadInvocationContext(invocationId: string) {
  const [row] = await db
    .select({
      invocation: botInvocations,
      bot: bots,
      botName: users.name,
      triggerMessage: messages,
      triggerSenderName: users.name,
      conversation: conversations,
    })
    .from(botInvocations)
    .innerJoin(bots, eq(botInvocations.botId, bots.id))
    .innerJoin(users, eq(bots.userId, users.id))
    .innerJoin(messages, eq(botInvocations.triggerMessageId, messages.id))
    .innerJoin(conversations, eq(botInvocations.conversationId, conversations.id))
    .where(eq(botInvocations.id, invocationId))
    .limit(1);

  if (!row) return null;

  const [triggerSender] = await db
    .select({ name: users.name })
    .from(users)
    .where(eq(users.id, row.triggerMessage.senderId))
    .limit(1);

  return {
    invocation: row.invocation,
    bot: row.bot,
    botName: row.botName,
    triggerMessage: row.triggerMessage,
    triggerSender: { name: triggerSender?.name ?? "Unknown" },
    conversation: row.conversation,
  };
}

async function markInvocationStatus(
  invocationId: string,
  status: BotInvocationStatus,
  fields: Partial<typeof botInvocations.$inferInsert> = {},
) {
  await db
    .update(botInvocations)
    .set({ ...fields, status, updatedAt: new Date() })
    .where(eq(botInvocations.id, invocationId));
}

async function publishInvocationUpdate(invocationId: string) {
  const [invocationRow] = await db
    .select({
      id: botInvocations.id,
      botId: botInvocations.botId,
      botUserId: bots.userId,
      botName: users.name,
      botKind: bots.kind,
      conversationId: botInvocations.conversationId,
      threadId: botInvocations.threadId,
      triggerMessageId: botInvocations.triggerMessageId,
      responseMessageId: botInvocations.responseMessageId,
      adapterKind: botInvocations.adapterKind,
      status: botInvocations.status,
      externalRunId: botInvocations.externalRunId,
      requestJson: botInvocations.requestJson,
      responseJson: botInvocations.responseJson,
      error: botInvocations.error,
      startedAt: botInvocations.startedAt,
      completedAt: botInvocations.completedAt,
      createdAt: botInvocations.createdAt,
      updatedAt: botInvocations.updatedAt,
    })
    .from(botInvocations)
    .innerJoin(bots, eq(botInvocations.botId, bots.id))
    .innerJoin(users, eq(bots.userId, users.id))
    .where(eq(botInvocations.id, invocationId))
    .limit(1);
  if (!invocationRow) return;

  const participantRows = await db
    .select({ userId: conversationParticipants.userId })
    .from(conversationParticipants)
    .where(eq(conversationParticipants.conversationId, invocationRow.conversationId));

  const wsEvent: WsServerEvent = {
    type: "bot_invocation_updated",
    conversationId: invocationRow.conversationId,
    invocation: toPublicInvocation(invocationRow),
  };
  await publishWsEventToUsers(participantRows.map((p) => p.userId), wsEvent);
}

async function publishBotMessage(
  message: typeof messages.$inferSelect,
  senderName: string,
  conversationType: ConversationType,
) {
  const participants = await db
    .select({ userId: conversationParticipants.userId })
    .from(conversationParticipants)
    .where(eq(conversationParticipants.conversationId, message.conversationId));
  const event: WsServerEvent = {
    type: "new_message",
    message: {
      id: message.id,
      conversationId: message.conversationId,
      threadId: message.threadId,
      senderId: message.senderId,
      senderName,
      senderType: "bot",
      content: message.content,
      parts: message.parts ?? null,
      createdAt: message.createdAt.toISOString(),
    } as ChatMessage,
    conversationType,
  };
  await publishWsEventToUsers(participants.map((p) => p.userId), event);
}

async function requireConversationParticipant(conversationId: string, userId: string) {
  const [participant] = await db
    .select({ userId: conversationParticipants.userId })
    .from(conversationParticipants)
    .where(and(eq(conversationParticipants.conversationId, conversationId), eq(conversationParticipants.userId, userId)))
    .limit(1);
  if (!participant) throw new ServiceError("You are not a participant of this conversation", 403);
}

async function requireConversationThread(conversationId: string, threadId: string) {
  const [thread] = await db
    .select({ id: conversationThreads.id })
    .from(conversationThreads)
    .where(
      and(
        eq(conversationThreads.id, threadId),
        eq(conversationThreads.conversationId, conversationId),
      ),
    )
    .limit(1);
  if (!thread) throw new ServiceError("Thread does not belong to this conversation", 400);
}

function getAsyncBus() {
  asyncBus ??= new BullMqAsyncBus();
  return asyncBus;
}

function toPublicInvocation(row: {
  id: string;
  botId: string;
  botUserId: string;
  botName: string;
  botKind: BotKind;
  conversationId: string;
  threadId: string | null;
  triggerMessageId: string;
  responseMessageId: string | null;
  adapterKind: string;
  status: string;
  externalRunId: string | null;
  requestJson: Record<string, unknown> | null;
  responseJson: Record<string, unknown> | null;
  error: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): BotInvocationPublic {
  return {
    id: row.id,
    botId: row.botId,
    botUserId: row.botUserId,
    botName: row.botName,
    botKind: row.botKind,
    conversationId: row.conversationId,
    threadId: row.threadId,
    triggerMessageId: row.triggerMessageId,
    responseMessageId: row.responseMessageId,
    adapterKind: row.adapterKind,
    status: row.status,
    externalRunId: row.externalRunId,
    requestJson: row.requestJson,
    responseJson: row.responseJson,
    error: row.error,
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
