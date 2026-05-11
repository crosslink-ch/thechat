import crypto from "crypto";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type {
  BotEventPublic,
  BotInvocationPublic,
  BotRuntimeSnapshot,
  BotSessionPublic,
  ChatMessage,
  WebhookPayload,
  WsServerEvent,
} from "@thechat/shared";
import { BullMqAsyncBus } from "../async";
import { AsyncWorkerRuntime } from "../async/worker";
import type { AsyncJobHandler, QueueCommand } from "../async/types";
import { db } from "../db";
import {
  botEvents,
  botInvocations,
  bots,
  botSessions,
  conversationParticipants,
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

export const BOT_QUEUE_NAME = "thechat:bots";
export const BOT_INVOKE_JOB_NAME = "bot.invoke";

type BotKind = "webhook" | "hermes";
type ConversationType = "direct" | "group";
type BotInvocationStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

interface TriggerMessage {
  id: string;
  content: string;
  conversationId: string;
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

let asyncBus: BullMqAsyncBus | null = null;
let botWorker: AsyncWorkerRuntime | null = null;
let botWorkerStartPromise: Promise<AsyncWorkerRuntime> | null = null;

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
        const isDirectHermesDm = conv.type === "direct" && b.kind === "hermes";
        return isMentioned || isDirectHermesDm;
      });

      for (const bot of triggeredBots) {
        await enqueueBotInvocation({ bot, conversation: conv, message: msg });
      }
    },
  );
}

export async function listConversationBotRuntime(conversationId: string, userId: string): Promise<BotRuntimeSnapshot> {
  await requireConversationParticipant(conversationId, userId);

  const sessionRows = await db
    .select({
      id: botSessions.id,
      botId: botSessions.botId,
      botUserId: bots.userId,
      botName: users.name,
      botKind: bots.kind,
      workspaceId: botSessions.workspaceId,
      conversationId: botSessions.conversationId,
      scope: botSessions.scope,
      externalSessionId: botSessions.externalSessionId,
      title: botSessions.title,
      status: botSessions.status,
      lastMessageId: botSessions.lastMessageId,
      createdAt: botSessions.createdAt,
      updatedAt: botSessions.updatedAt,
    })
    .from(botSessions)
    .innerJoin(bots, eq(botSessions.botId, bots.id))
    .innerJoin(users, eq(bots.userId, users.id))
    .where(eq(botSessions.conversationId, conversationId))
    .orderBy(desc(botSessions.updatedAt));

  const invocationRows = await db
    .select({
      id: botInvocations.id,
      botSessionId: botInvocations.botSessionId,
      botId: botInvocations.botId,
      botUserId: bots.userId,
      botName: users.name,
      botKind: bots.kind,
      conversationId: botInvocations.conversationId,
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
    .where(eq(botInvocations.conversationId, conversationId))
    .orderBy(desc(botInvocations.createdAt))
    .limit(50);

  const invocationIds = invocationRows.map((row) => row.id);
  const eventRows =
    invocationIds.length === 0
      ? []
      : await db
          .select()
          .from(botEvents)
          .where(inArray(botEvents.invocationId, invocationIds))
          .orderBy(asc(botEvents.createdAt));

  return {
    sessions: sessionRows.map(toPublicSession),
    invocations: invocationRows.map(toPublicInvocation),
    events: eventRows.map(toPublicEvent),
  };
}

export async function startBotWorker(options: { concurrency?: number } = {}): Promise<AsyncWorkerRuntime> {
  if (botWorkerStartPromise) return botWorkerStartPromise;
  botWorkerStartPromise = (async () => {
    const runtime = new AsyncWorkerRuntime({ concurrency: options.concurrency });
    runtime.register(createBotInvokeHandler());
    await runtime.start([BOT_QUEUE_NAME]);
    botWorker = runtime;
    return runtime;
  })();
  return botWorkerStartPromise;
}

export async function closeBotRuntimeForTests(): Promise<void> {
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

async function enqueueBotInvocation(input: {
  bot: TriggeredBot;
  conversation: ConversationRow;
  message: TriggerMessage;
}) {
  const session = await getOrCreateBotSession(input.bot.botId, input.conversation);
  const invocation = await getOrCreateInvocation(input.bot, input.conversation, input.message, session.id);
  const event = await recordBotEvent(invocation.id, "invocation.queued", {
    triggerMessageId: input.message.id,
  });
  await publishInvocationUpdate(invocation.id, event);

  if (input.bot.kind === "hermes") {
    return;
  }

  const command = createBotInvokeCommand(invocation.id, input.conversation.workspaceId, input.message.id);
  await getAsyncBus().enqueue(command);
  if (process.env.BOT_WORKER_AUTOSTART !== "0") {
    await startBotWorker();
  }
}

async function getOrCreateBotSession(botId: string, conversation: ConversationRow) {
  const [config] = await db
    .select({ defaultSessionScope: hermesBotConfigs.defaultSessionScope })
    .from(hermesBotConfigs)
    .where(eq(hermesBotConfigs.botId, botId))
    .limit(1);
  const requestedScope = config?.defaultSessionScope ?? "channel";
  const scope = requestedScope === "workspace" ? "workspace" : "conversation";
  const externalSessionId = sessionKey(conversation.workspaceId, scope === "workspace" ? null : conversation.id, botId);

  const inserted = await db
    .insert(botSessions)
    .values({
      botId,
      workspaceId: conversation.workspaceId,
      conversationId: conversation.id,
      scope,
      externalSessionId,
      title: conversation.name,
    })
    .onConflictDoNothing({
      target: [botSessions.botId, botSessions.conversationId, botSessions.scope],
    })
    .returning();

  if (inserted[0]) return inserted[0];

  const [existing] = await db
    .select()
    .from(botSessions)
    .where(
      and(
        eq(botSessions.botId, botId),
        eq(botSessions.conversationId, conversation.id),
        eq(botSessions.scope, scope),
      ),
    )
    .limit(1);
  if (!existing) throw new Error("Failed to create bot session");
  return existing;
}

async function getOrCreateInvocation(
  bot: TriggeredBot,
  conversation: ConversationRow,
  message: TriggerMessage,
  sessionId: string,
) {
  const inserted = await db
    .insert(botInvocations)
    .values({
      botSessionId: sessionId,
      botId: bot.botId,
      conversationId: conversation.id,
      triggerMessageId: message.id,
      adapterKind: bot.kind,
      status: "queued",
      requestJson: {
        messageId: message.id,
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
  await publishInvocationUpdate(invocationId, await recordBotEvent(invocationId, "invocation.running", {}));
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
  await recordBotEvent(invocationId, "webhook.dispatching", { webhookUrl: loaded.bot.webhookUrl });

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
  await publishInvocationUpdate(
    invocationId,
    await recordBotEvent(invocationId, "webhook.completed", { status: response.status }),
  );
}

export interface HermesPlatformEvent {
  id: string;
  invocationId: string;
  chatId: string;
  chatType: "dm" | "group";
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
  session: { id: string; externalSessionId: string | null };
}

export async function claimHermesPlatformEvents(botId: string, limit = 10): Promise<HermesPlatformEvent[]> {
  const cappedLimit = Math.max(1, Math.min(limit, 50));
  const pending = await db
    .select({ id: botInvocations.id })
    .from(botInvocations)
    .innerJoin(bots, eq(botInvocations.botId, bots.id))
    .where(and(
      eq(botInvocations.status, "queued"),
      eq(botInvocations.adapterKind, "hermes"),
      eq(botInvocations.botId, botId),
      eq(bots.kind, "hermes"),
    ))
    .orderBy(asc(botInvocations.createdAt))
    .limit(cappedLimit);

  const events: HermesPlatformEvent[] = [];
  for (const row of pending) {
    const now = new Date();
    const [claimed] = await db
      .update(botInvocations)
      .set({
        status: "running",
        startedAt: now,
        externalRunId: `thechat:${row.id}`,
        error: null,
        updatedAt: now,
      })
      .where(and(eq(botInvocations.id, row.id), eq(botInvocations.status, "queued")))
      .returning({ id: botInvocations.id });
    if (!claimed) continue;

    const loaded = await loadInvocationContext(row.id);
    if (!loaded || loaded.bot.kind !== "hermes" || !loaded.session) {
      await failInvocation(row.id, new Error("Hermes invocation context is incomplete"));
      continue;
    }

    const [config] = await db
      .select({
        defaultInstructions: hermesBotConfigs.defaultInstructions,
        defaultSessionScope: hermesBotConfigs.defaultSessionScope,
      })
      .from(hermesBotConfigs)
      .where(eq(hermesBotConfigs.botId, loaded.bot.id))
      .limit(1);

    const text = stripBotMention(loaded.triggerMessage.content, loaded.botName) || loaded.triggerMessage.content;
    await db
      .update(botInvocations)
      .set({
        requestJson: {
          platform: "thechat",
          messageId: loaded.triggerMessage.id,
          messageContent: loaded.triggerMessage.content,
          text,
          sessionId: loaded.session.externalSessionId,
          defaultSessionScope: config?.defaultSessionScope ?? "channel",
          triggeredAt: loaded.triggerMessage.createdAt.toISOString(),
        },
      })
      .where(eq(botInvocations.id, row.id));

    await publishInvocationUpdate(
      row.id,
      await recordBotEvent(row.id, "hermes.platform.claimed", {
        sessionId: loaded.session.externalSessionId,
      }),
    );

    events.push({
      id: row.id,
      invocationId: row.id,
      chatId: loaded.session.externalSessionId ?? loaded.session.id,
      chatType: loaded.conversation.type === "direct" ? "dm" : "group",
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
      session: {
        id: loaded.session.id,
        externalSessionId: loaded.session.externalSessionId,
      },
    });
  }

  return events;
}

export async function completeHermesPlatformInvocation(input: {
  authenticatedBotId: string;
  invocationId: string;
  content: string;
  platformMessageId?: string | null;
  botId?: string;
  conversationId?: string;
}) {
  const content = input.content.trim();
  if (!content) throw new ServiceError("Message content is required", 400);

  const loaded = await loadInvocationContext(input.invocationId);
  if (!loaded) throw new ServiceError("Invocation not found", 404);
  if (loaded.bot.kind !== "hermes") throw new ServiceError("Invocation is not for a Hermes bot", 400);
  if (loaded.bot.id !== input.authenticatedBotId) throw new ServiceError("Bot token does not match invocation", 403);
  if (input.botId && input.botId !== loaded.bot.id) throw new ServiceError("Bot does not match invocation", 400);
  if (input.conversationId && input.conversationId !== loaded.conversation.id) {
    throw new ServiceError("Conversation does not match invocation", 400);
  }

  if (loaded.invocation.responseMessageId && loaded.invocation.status === "completed") {
    return { messageId: loaded.invocation.responseMessageId, duplicate: true };
  }

  const [responseMessage] = await db
    .insert(messages)
    .values({
      conversationId: loaded.conversation.id,
      senderId: loaded.bot.userId,
      content,
      parts: [{ type: "text", text: content }],
    })
    .returning();

  const completedAt = new Date();
  await db
    .update(botInvocations)
    .set({
      status: "completed",
      responseMessageId: responseMessage.id,
      responseJson: {
        platform: "thechat",
        platformMessageId: input.platformMessageId ?? null,
        output: content,
      },
      completedAt,
      updatedAt: completedAt,
    })
    .where(eq(botInvocations.id, input.invocationId));
  if (loaded.session) {
    await db
      .update(botSessions)
      .set({ lastMessageId: responseMessage.id, updatedAt: completedAt })
      .where(eq(botSessions.id, loaded.session.id));
  }

  await publishBotMessage(responseMessage, loaded.botName, loaded.conversation.type);
  await publishInvocationUpdate(
    input.invocationId,
    await recordBotEvent(input.invocationId, "invocation.completed", {
      responseMessageId: responseMessage.id,
      platformMessageId: input.platformMessageId ?? null,
    }),
  );
  return { messageId: responseMessage.id, duplicate: false };
}

export async function completeHermesPlatformInvocationSilently(input: {
  authenticatedBotId: string;
  invocationId: string;
  reason?: string | null;
}) {
  const loaded = await loadInvocationContext(input.invocationId);
  if (!loaded) throw new ServiceError("Invocation not found", 404);
  if (loaded.bot.kind !== "hermes") throw new ServiceError("Invocation is not for a Hermes bot", 400);
  if (loaded.bot.id !== input.authenticatedBotId) throw new ServiceError("Bot token does not match invocation", 403);

  if (loaded.invocation.status === "completed") {
    return { ok: true, duplicate: true };
  }

  const completedAt = new Date();
  await db
    .update(botInvocations)
    .set({
      status: "completed",
      responseJson: {
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

  await publishInvocationUpdate(
    input.invocationId,
    await recordBotEvent(input.invocationId, "invocation.completed", {
      silent: true,
      reason: input.reason ?? null,
    }),
  );
  return { ok: true, duplicate: false };
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

  await publishInvocationUpdate(
    input.invocationId,
    await recordBotEvent(input.invocationId, "invocation.cancelled", { reason }),
  );
  return { ok: true, duplicate: false };
}

export async function publishHermesPlatformTyping(input: {
  authenticatedBotId: string;
  invocationId: string;
  botId?: string;
  conversationId?: string;
}) {
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
  await publishWsEventToUsers(participantRows.map((p) => p.userId), {
    type: "typing",
    conversationId: loaded.conversation.id,
    userId: loaded.bot.userId,
    userName: loaded.botName,
  });
  return { ok: true };
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
  const event = await recordBotEvent(invocationId, "invocation.failed", { error: message });

  if (loaded?.bot.kind === "hermes") {
    const content = `Hermes run failed: ${message}`;
    const [responseMessage] = await db
      .insert(messages)
      .values({
        conversationId: loaded.conversation.id,
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

  await publishInvocationUpdate(invocationId, event);
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
      session: botSessions,
    })
    .from(botInvocations)
    .innerJoin(bots, eq(botInvocations.botId, bots.id))
    .innerJoin(users, eq(bots.userId, users.id))
    .innerJoin(messages, eq(botInvocations.triggerMessageId, messages.id))
    .innerJoin(conversations, eq(botInvocations.conversationId, conversations.id))
    .leftJoin(botSessions, eq(botInvocations.botSessionId, botSessions.id))
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
    session: row.session,
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

async function recordBotEvent(invocationId: string, type: string, payload: Record<string, unknown>) {
  const [event] = await db
    .insert(botEvents)
    .values({ invocationId, type, payload })
    .returning();
  return event;
}

async function publishInvocationUpdate(invocationId: string, eventRow: typeof botEvents.$inferSelect | null) {
  const [invocationRow] = await db
    .select({
      id: botInvocations.id,
      botSessionId: botInvocations.botSessionId,
      botId: botInvocations.botId,
      botUserId: bots.userId,
      botName: users.name,
      botKind: bots.kind,
      conversationId: botInvocations.conversationId,
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

  const [sessionRow] = invocationRow.botSessionId
    ? await db
        .select({
          id: botSessions.id,
          botId: botSessions.botId,
          botUserId: bots.userId,
          botName: users.name,
          botKind: bots.kind,
          workspaceId: botSessions.workspaceId,
          conversationId: botSessions.conversationId,
          scope: botSessions.scope,
          externalSessionId: botSessions.externalSessionId,
          title: botSessions.title,
          status: botSessions.status,
          lastMessageId: botSessions.lastMessageId,
          createdAt: botSessions.createdAt,
          updatedAt: botSessions.updatedAt,
        })
        .from(botSessions)
        .innerJoin(bots, eq(botSessions.botId, bots.id))
        .innerJoin(users, eq(bots.userId, users.id))
        .where(eq(botSessions.id, invocationRow.botSessionId))
        .limit(1)
    : [null];

  const participantRows = await db
    .select({ userId: conversationParticipants.userId })
    .from(conversationParticipants)
    .where(eq(conversationParticipants.conversationId, invocationRow.conversationId));

  const wsEvent: WsServerEvent = {
    type: "bot_invocation_updated",
    conversationId: invocationRow.conversationId,
    invocation: toPublicInvocation(invocationRow),
    session: sessionRow ? toPublicSession(sessionRow) : null,
    event: eventRow ? toPublicEvent(eventRow) : null,
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

function sessionKey(workspaceId: string | null, conversationId: string | null, botId: string) {
  const workspacePart = workspaceId ? `workspace:${workspaceId}` : "workspace:none";
  const conversationPart = conversationId ? `conversation:${conversationId}` : "conversation:workspace";
  return `thechat:${workspacePart}:${conversationPart}:bot:${botId}`;
}

function getAsyncBus() {
  asyncBus ??= new BullMqAsyncBus();
  return asyncBus;
}

function toPublicSession(row: {
  id: string;
  botId: string;
  botUserId: string;
  botName: string;
  botKind: BotKind;
  workspaceId: string | null;
  conversationId: string | null;
  scope: string;
  externalSessionId: string | null;
  title: string | null;
  status: string;
  lastMessageId: string | null;
  createdAt: Date;
  updatedAt: Date;
}): BotSessionPublic {
  return {
    id: row.id,
    botId: row.botId,
    botUserId: row.botUserId,
    botName: row.botName,
    botKind: row.botKind,
    workspaceId: row.workspaceId,
    conversationId: row.conversationId,
    scope: row.scope,
    externalSessionId: row.externalSessionId,
    title: row.title,
    status: row.status,
    lastMessageId: row.lastMessageId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toPublicInvocation(row: {
  id: string;
  botSessionId: string | null;
  botId: string;
  botUserId: string;
  botName: string;
  botKind: BotKind;
  conversationId: string;
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
    botSessionId: row.botSessionId,
    botId: row.botId,
    botUserId: row.botUserId,
    botName: row.botName,
    botKind: row.botKind,
    conversationId: row.conversationId,
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

function toPublicEvent(row: typeof botEvents.$inferSelect): BotEventPublic {
  return {
    id: row.id,
    invocationId: row.invocationId,
    type: row.type,
    payload: row.payload ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}
