/**
 * Cross-package integration test: simulate TheChat API firing a signed
 * webhook at the plugin's inbound handler, and assert the full
 * verify → gate → dispatch chain produces the right outcome.
 *
 * We hand-roll the TheChat API signing recipe (`HMAC-SHA256("${ts}.${body}")`,
 * hex-encoded) here rather than importing it from `@thechat/api`, because
 * pulling in that module also loads the API's DB layer (which requires
 * DATABASE_URL). The signature format itself is locked down by
 * `signWebhookPayload`'s tests on the API side, plus
 * `webhooks.unit.test.ts`.
 */
import { describe, test, expect } from "bun:test";
import crypto from "node:crypto";
import { handleInbound } from "./inbound.js";
import type { TheChatChannelConfig, TheChatWebhookPayload } from "./types.js";

const cfg: TheChatChannelConfig = {
  baseUrl: "https://chat.example",
  botId: "bot-1",
  botUserId: "user-bot-1",
  apiKey: "bot_xyz",
  webhookSecret: "whsec_integration_secret_value",
};

const NOW = 1_700_000_000;

function apiSign(body: string, secret: string, timestamp: number): string {
  return crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("hex");
}

function buildAndSign(payload: TheChatWebhookPayload, ts = NOW) {
  const body = JSON.stringify(payload);
  const sig = apiSign(body, cfg.webhookSecret, ts);
  return {
    body,
    headers: {
      "X-Webhook-Timestamp": String(ts),
      "X-Webhook-Signature": sig,
      "X-Webhook-Event": payload.event,
    },
  };
}

const baseDM: TheChatWebhookPayload = {
  event: "direct_message",
  message: {
    id: "msg-1",
    content: "hi bot",
    conversationId: "conv-1",
    senderId: "user-human",
    senderName: "Alice",
    senderType: "human",
    createdAt: new Date(NOW * 1000).toISOString(),
  },
  conversation: {
    id: "conv-1",
    type: "direct",
    kind: "dm",
    name: null,
    workspaceId: "ws-1",
  },
  workspace: { id: "ws-1", name: "WS" },
  bot: { id: "bot-1", userId: "user-bot-1", name: "Bot" },
};

describe("integration: API → plugin", () => {
  test("API-signed DM is accepted and dispatched by the plugin", () => {
    const { body, headers } = buildAndSign(baseDM);
    const r = handleInbound({
      body,
      headers,
      config: cfg,
      nowSeconds: () => NOW,
    });
    expect(r.kind).toBe("dispatched");
    if (r.kind === "dispatched") {
      expect(r.mapping.to).toBe("dm:conv-1");
      expect(r.payload.event).toBe("direct_message");
    }
  });

  test("API-signed mention in a channel is accepted", () => {
    const mention: TheChatWebhookPayload = {
      ...baseDM,
      event: "mention",
      message: { ...baseDM.message, id: "msg-2", content: "hey @Bot" },
      conversation: {
        id: "conv-2",
        type: "group",
        kind: "channel",
        name: "general",
        workspaceId: "ws-1",
      },
    };
    const { body, headers } = buildAndSign(mention);
    const r = handleInbound({
      body,
      headers,
      config: cfg,
      nowSeconds: () => NOW,
    });
    expect(r.kind).toBe("dispatched");
    if (r.kind === "dispatched") {
      expect(r.mapping.to).toBe("channel:conv-2");
    }
  });

  test("Bot-loop prevention: sender_type=bot DM is dropped", () => {
    const fromBot: TheChatWebhookPayload = {
      ...baseDM,
      message: {
        ...baseDM.message,
        senderId: "user-bot-2",
        senderType: "bot",
      },
    };
    const { body, headers } = buildAndSign(fromBot);
    const r = handleInbound({
      body,
      headers,
      config: cfg,
      nowSeconds: () => NOW,
    });
    expect(r.kind).toBe("skipped");
    if (r.kind === "skipped") expect(r.reason).toBe("other_bot_blocked");
  });

  test("Tampered body produced after API signs is rejected", () => {
    const { body, headers } = buildAndSign(baseDM);
    const tampered = body.replace("hi bot", "DROP TABLE");
    const r = handleInbound({
      body: tampered,
      headers,
      config: cfg,
      nowSeconds: () => NOW,
    });
    expect(r.kind).toBe("rejected");
    if (r.kind === "rejected") expect(r.reason).toBe("bad_signature");
  });
});
