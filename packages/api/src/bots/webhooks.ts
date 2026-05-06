import { eq } from "drizzle-orm";
import crypto from "crypto";
import { db } from "../db";
import {
  bots,
  users,
  conversations,
  conversationParticipants,
  workspaces,
} from "../db/schema";
import type { WebhookPayload } from "@thechat/shared";
import { handleHermesMention } from "../services/hermes";

/**
 * Sign a webhook payload with HMAC-SHA256.
 * Returns the hex-encoded signature.
 */
export function signWebhookPayload(
  body: string,
  secret: string,
  timestamp: number
): string {
  const signedContent = `${timestamp}.${body}`;
  return crypto
    .createHmac("sha256", secret)
    .update(signedContent)
    .digest("hex");
}

/**
 * After a message is created, check for @mentions of bots in the conversation
 * and dispatch either generic webhooks or native Hermes runs.
 */
export async function processMessageMentions(msg: {
  id: string;
  content: string;
  conversationId: string;
  senderId: string;
  senderName: string;
  createdAt: string;
}) {
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

  const mentionedBots = participantBots.filter((b) => {
    const escaped = b.botName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`@${escaped}\\b`, "i");
    return regex.test(msg.content);
  });

  if (mentionedBots.length === 0) return;

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

  let workspace: { id: string; name: string } | null = null;
  if (conv.workspaceId) {
    const [ws] = await db
      .select({ id: workspaces.id, name: workspaces.name })
      .from(workspaces)
      .where(eq(workspaces.id, conv.workspaceId))
      .limit(1);
    if (ws) workspace = ws;
  }

  for (const bot of mentionedBots) {
    if (bot.kind === "hermes") {
      handleHermesMention({
        botId: bot.botId,
        botUserId: bot.botUserId,
        botName: bot.botName,
        message: msg,
        conversation: { id: conv.id, type: conv.type, workspaceId: conv.workspaceId },
      }).catch(console.error);
      continue;
    }

    if (!bot.webhookUrl) continue;
    const payload: WebhookPayload = {
      event: "mention",
      message: {
        id: msg.id,
        content: msg.content,
        conversationId: msg.conversationId,
        senderId: msg.senderId,
        senderName: msg.senderName,
        createdAt: msg.createdAt,
      },
      conversation: {
        id: conv.id,
        type: conv.type,
        name: conv.name,
        workspaceId: conv.workspaceId,
      },
      workspace,
      bot: { id: bot.botId, name: bot.botName },
    };

    const body = JSON.stringify(payload);
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = signWebhookPayload(body, bot.webhookSecret, timestamp);

    fetch(bot.webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Timestamp": String(timestamp),
        "X-Webhook-Signature": signature,
      },
      body,
    }).catch(console.error);
  }
}
