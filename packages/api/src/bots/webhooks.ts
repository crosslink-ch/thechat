import { eq, ne, isNotNull, and } from "drizzle-orm";
import { db } from "../db";
import {
  bots,
  users,
  conversations,
  conversationParticipants,
  workspaces,
} from "../db/schema";
import type { WebhookPayload } from "@thechat/shared";
import { log } from "../lib/logger";
import {
  selectDispatchTargets,
  signWebhookPayload,
  isMentioned,
  type BotEventInput,
  type BotRecord,
  type DispatchTarget,
} from "./webhooks-core";

export {
  signWebhookPayload,
  isMentioned,
  selectDispatchTargets,
};
export type { BotEventInput, BotRecord, DispatchTarget };

const WEBHOOK_TIMEOUT_MS = 5000;

/**
 * After a message is created, decide which bots should be notified and POST
 * a signed webhook to each. Fire-and-forget: the calling request does not
 * wait for delivery to complete.
 */
export async function processBotEvents(msg: BotEventInput): Promise<void> {
  // 1. Look up conversation type (DM vs group) — gates whether @mention is
  //    required for delivery.
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

  if (!conv) {
    log.warn("bots.webhooks", "conversation_not_found", {
      conversationId: msg.conversationId,
      messageId: msg.id,
    });
    return;
  }

  // 2. Find bots that participate in this conversation AND have a webhook
  //    configured. Single query — previously this fetched every bot row in
  //    the system and filtered in JS.
  const participantBots = await db
    .select({
      botId: bots.id,
      botUserId: bots.userId,
      webhookUrl: bots.webhookUrl,
      webhookSecret: bots.webhookSecret,
      botName: users.name,
    })
    .from(bots)
    .innerJoin(users, eq(bots.userId, users.id))
    .innerJoin(
      conversationParticipants,
      eq(conversationParticipants.userId, bots.userId)
    )
    .where(
      and(
        eq(conversationParticipants.conversationId, msg.conversationId),
        isNotNull(bots.webhookUrl),
        // Don't even fetch the bot that authored the message.
        ne(bots.userId, msg.senderId)
      )
    );

  if (participantBots.length === 0) return;

  const eligible: BotRecord[] = participantBots
    .filter((b): b is typeof b & { webhookUrl: string } => b.webhookUrl !== null)
    .map((b) => ({
      botId: b.botId,
      botUserId: b.botUserId,
      webhookUrl: b.webhookUrl,
      webhookSecret: b.webhookSecret,
      botName: b.botName,
    }));

  const targets = selectDispatchTargets({
    message: msg,
    conversationType: conv.type,
    participantBots: eligible,
  });

  if (targets.length === 0) {
    log.debug("bots.webhooks", "no_targets", {
      conversationId: msg.conversationId,
      conversationType: conv.type,
      senderType: msg.senderType,
      eligibleBotCount: eligible.length,
    });
    return;
  }

  // 3. Resolve workspace metadata once.
  let workspace: { id: string; name: string } | null = null;
  if (conv.workspaceId) {
    const [ws] = await db
      .select({ id: workspaces.id, name: workspaces.name })
      .from(workspaces)
      .where(eq(workspaces.id, conv.workspaceId))
      .limit(1);
    if (ws) workspace = ws;
  }

  // 4. Fire webhooks (fire-and-forget; each delivery is independent).
  for (const target of targets) {
    void deliverWebhook({
      target,
      conversation: conv,
      workspace,
      message: msg,
    });
  }
}

/**
 * Backward-compatible alias. Older code/tests may call processMessageMentions;
 * keep the name resolving to the new generalized handler.
 */
export const processMessageMentions = processBotEvents;

interface DeliveryArgs {
  target: DispatchTarget;
  conversation: {
    id: string;
    type: "direct" | "group";
    name: string | null;
    workspaceId: string | null;
  };
  workspace: { id: string; name: string } | null;
  message: BotEventInput;
}

async function deliverWebhook({
  target,
  conversation,
  workspace,
  message,
}: DeliveryArgs): Promise<void> {
  const { bot, event } = target;

  const payload: WebhookPayload = {
    event,
    message: {
      id: message.id,
      content: message.content,
      conversationId: message.conversationId,
      senderId: message.senderId,
      senderName: message.senderName,
      senderType: message.senderType,
      createdAt: message.createdAt,
    },
    conversation: {
      id: conversation.id,
      type: conversation.type,
      kind: conversation.type === "direct" ? "dm" : "channel",
      name: conversation.name,
      workspaceId: conversation.workspaceId,
    },
    workspace,
    bot: { id: bot.botId, userId: bot.botUserId, name: bot.botName },
  };

  const body = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = signWebhookPayload(body, bot.webhookSecret, timestamp);

  log.info("bots.webhooks", "deliver_attempt", {
    botId: bot.botId,
    botUserId: bot.botUserId,
    event,
    conversationId: conversation.id,
    conversationType: conversation.type,
    messageId: message.id,
  });

  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);

  try {
    const res = await fetch(bot.webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Timestamp": String(timestamp),
        "X-Webhook-Signature": signature,
        "X-Webhook-Event": event,
        "User-Agent": "TheChat-Webhook/1",
      },
      body,
      signal: controller.signal,
    });

    const durationMs = Date.now() - start;
    if (!res.ok) {
      log.warn("bots.webhooks", "deliver_failed_status", {
        botId: bot.botId,
        event,
        status: res.status,
        durationMs,
      });
    } else {
      log.info("bots.webhooks", "deliver_ok", {
        botId: bot.botId,
        event,
        status: res.status,
        durationMs,
      });
    }
  } catch (e: unknown) {
    const durationMs = Date.now() - start;
    const err = e instanceof Error ? e : new Error(String(e));
    log.warn("bots.webhooks", "deliver_exception", {
      botId: bot.botId,
      event,
      durationMs,
      error: err.message,
      aborted: controller.signal.aborted,
    });
  } finally {
    clearTimeout(timer);
  }
}
