import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { botRequests, bots } from "../db/schema";
import {
  PermanentDomainEventError,
  type DomainEventHandler,
} from "../events/registry";
import { withSpan } from "../observability";
import {
  loadBotRequestBotView,
  publishBotRequestUpdate,
  MAX_BOT_REQUEST_REASON_LENGTH,
} from "../services/bot-requests";
import { signWebhookPayload } from "../services/bot-runtime";
import {
  BOT_REQUEST_ANSWERED_EVENT_TYPE,
  BOT_REQUEST_ANSWERED_EVENT_VERSION,
  parseBotRequestAnsweredV1,
  type BotRequestAnsweredV1,
} from "./events";

export const BOT_REQUEST_WEBHOOK_TYPE = "thechat.bot_request.answered";
const DEFAULT_DELIVERY_TIMEOUT_MS = 15_000;

/** Narrow, retryable transport failure. Never includes the webhook URL. */
class BotRequestDeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BotRequestDeliveryError";
  }
}

function deliveryTimeoutMs() {
  const parsed = Number.parseInt(process.env.BOT_REQUEST_DELIVERY_TIMEOUT_MS ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_DELIVERY_TIMEOUT_MS;
}

/**
 * Push a stored answer to a webhook bot. Polling bots receive answers through
 * their poll instead, so they need nothing here. A 2xx reply that carries
 * `{applied: boolean}` doubles as the bot's acknowledgement.
 */
export async function deliverBotRequestAnswer(requestId: string): Promise<void> {
  await withSpan(
    "bot_request.answer.deliver",
    { "messaging.system": "thechat", "messaging.destination.kind": "bot_webhook" },
    async (span) => {
      const request = await loadBotRequestBotView(requestId);
      if (!request || request.status !== "answered") {
        span.setAttribute("thechat.bot_request.delivery", "not_pending");
        return;
      }
      const [bot] = await db
        .select({ id: bots.id, webhookUrl: bots.webhookUrl, webhookSecret: bots.webhookSecret })
        .from(bots)
        .where(eq(bots.id, request.botId))
        .limit(1);
      const webhookUrl = bot?.webhookUrl?.trim();
      if (!bot || !webhookUrl) {
        span.setAttribute("thechat.bot_request.delivery", "polling");
        return;
      }
      let url: URL;
      try {
        url = new URL(webhookUrl);
      } catch {
        throw new PermanentDomainEventError("Bot webhook URL is invalid");
      }
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new PermanentDomainEventError("Bot webhook URL must use http or https");
      }

      const body = JSON.stringify({ type: BOT_REQUEST_WEBHOOK_TYPE, request });
      const timestamp = Math.floor(Date.now() / 1000);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), deliveryTimeoutMs());
      let response: Response;
      try {
        response = await fetch(webhookUrl, {
          method: "POST",
          redirect: "error",
          signal: controller.signal,
          headers: {
            "Content-Type": "application/json",
            "X-Webhook-Timestamp": String(timestamp),
            "X-Webhook-Signature": signWebhookPayload(body, bot.webhookSecret, timestamp),
            "X-TheChat-Bot-Id": bot.id,
            "X-TheChat-Bot-Request-Id": request.id,
          },
          body,
        });
      } catch {
        span.setAttribute("thechat.bot_request.delivery", "unreachable");
        throw new BotRequestDeliveryError(
          controller.signal.aborted
            ? "Bot webhook did not answer in time"
            : "Could not reach the bot webhook",
        );
      } finally {
        clearTimeout(timeout);
      }
      span.setAttribute("http.response.status_code", response.status);
      if (!response.ok) {
        span.setAttribute("thechat.bot_request.delivery", "rejected");
        if (response.status >= 500 || response.status === 408 || response.status === 429) {
          throw new BotRequestDeliveryError(`Bot webhook failed with HTTP ${response.status}`);
        }
        throw new PermanentDomainEventError(
          `Bot webhook rejected the answer with HTTP ${response.status}`,
        );
      }

      const ack = await response.json().catch(() => null);
      if (ack && typeof ack === "object" && typeof (ack as { applied?: unknown }).applied === "boolean") {
        const note = (ack as { note?: unknown }).note;
        const now = new Date();
        const [updated] = await db
          .update(botRequests)
          .set({
            status: "delivered",
            deliveredAt: now,
            deliveryApplied: (ack as { applied: boolean }).applied,
            deliveryNote:
              typeof note === "string" && note.trim()
                ? note.trim().slice(0, MAX_BOT_REQUEST_REASON_LENGTH)
                : null,
            updatedAt: now,
          })
          .where(and(eq(botRequests.id, request.id), eq(botRequests.status, "answered")))
          .returning({ id: botRequests.id });
        if (updated) await publishBotRequestUpdate(request.id);
        span.setAttribute("thechat.bot_request.delivery", "acknowledged");
        return;
      }
      span.setAttribute("thechat.bot_request.delivery", "pushed");
    },
  );
}

export function createBotRequestAnsweredHandler(): DomainEventHandler<BotRequestAnsweredV1> {
  return {
    type: BOT_REQUEST_ANSWERED_EVENT_TYPE,
    version: BOT_REQUEST_ANSWERED_EVENT_VERSION,
    parse: parseBotRequestAnsweredV1,
    async handle(event) {
      await deliverBotRequestAnswer(event.payload.requestId);
    },
  };
}
