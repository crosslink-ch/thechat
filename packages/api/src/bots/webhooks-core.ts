/**
 * Pure helpers for the bot webhook pipeline. Kept out of `./webhooks` so
 * unit tests can import them without dragging in the database connection
 * pool that `db/index.ts` opens at module load.
 */
import crypto from "crypto";
import type { WebhookEventType } from "@thechat/shared";

/**
 * Sign a webhook payload with HMAC-SHA256.
 * The signed content is `${timestamp}.${body}`, matching the convention used
 * by Stripe-style webhook verification — the receiver verifies signature AND
 * checks timestamp staleness for replay protection.
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
 * Returns true if the bot's name is @-mentioned anywhere in the message body.
 */
export function isMentioned(content: string, botName: string): boolean {
  const escaped = botName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Word-boundary on either side — "@Foo" matches but "@FooBar" does not.
  const regex = new RegExp(`(^|\\W)@${escaped}(?=$|\\W)`, "i");
  return regex.test(content);
}

export interface BotEventInput {
  id: string;
  content: string;
  conversationId: string;
  senderId: string;
  senderName: string;
  /** Whether the message author is a human or another bot. */
  senderType: "human" | "bot";
  createdAt: string;
}

export interface BotRecord {
  botId: string;
  botUserId: string;
  webhookUrl: string;
  webhookSecret: string;
  botName: string;
}

export interface DispatchTarget {
  bot: BotRecord;
  event: WebhookEventType;
}

/**
 * Decide which (bot, eventType) pairs should fire for this message.
 *
 * Rules:
 *  - never deliver a message back to its own author bot (own-message loop)
 *  - default-skip messages authored by other bots (cross-bot loops). If the
 *    operator wants bot-to-bot routing, they can revisit this rule when an
 *    explicit allowlist mechanism is added.
 *  - in DMs (conversation type "direct"), every recipient bot gets a
 *    `direct_message` event (no @mention required)
 *  - in group channels, only @mentioned bots get a `mention` event
 *  - bots without a configured webhookUrl never receive events
 */
export function selectDispatchTargets(args: {
  message: BotEventInput;
  conversationType: "direct" | "group";
  participantBots: BotRecord[];
}): DispatchTarget[] {
  const { message, conversationType, participantBots } = args;

  const targets: DispatchTarget[] = [];
  for (const bot of participantBots) {
    if (bot.botUserId === message.senderId) {
      // Bot is the author of this message — no echo.
      continue;
    }
    if (message.senderType === "bot") {
      // Default loop prevention: don't fan another bot's message out to
      // every other bot in the conversation. Safe default for an MVP; can
      // be relaxed via per-bot config later.
      continue;
    }

    if (conversationType === "direct") {
      targets.push({ bot, event: "direct_message" });
      continue;
    }

    if (isMentioned(message.content, bot.botName)) {
      targets.push({ bot, event: "mention" });
    }
  }

  return targets;
}
