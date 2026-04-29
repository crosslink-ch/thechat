import { describe, test, expect } from "bun:test";
import { handleInbound } from "./inbound.js";
import { computeSignature } from "./signature.js";
import { createIdempotencyStore } from "./idempotency.js";
import type { TheChatChannelConfig, TheChatWebhookPayload } from "./types.js";

const cfg: TheChatChannelConfig = {
  baseUrl: "https://chat.example",
  botId: "bot-1",
  botUserId: "user-bot-1",
  apiKey: "bot_x",
  webhookSecret: "whsec_secretvalue",
};

const NOW = 1_700_000_000;

function signed(payload: TheChatWebhookPayload, ts = NOW) {
  const body = JSON.stringify(payload);
  const sig = computeSignature({
    body,
    timestamp: ts,
    secret: cfg.webhookSecret,
  });
  return {
    body,
    headers: {
      "X-Webhook-Timestamp": String(ts),
      "X-Webhook-Signature": sig,
    },
  };
}

function dmPayload(
  messageId = "m1"
): TheChatWebhookPayload {
  return {
    event: "direct_message",
    message: {
      id: messageId,
      content: "hi",
      conversationId: "conv-1",
      senderId: "user-human-1",
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
}

describe("handleInbound — idempotency", () => {
  test("first delivery is dispatched", () => {
    const store = createIdempotencyStore({
      ttlMs: 60_000,
      sweepIntervalMs: 999_999,
      nowMs: () => NOW * 1000,
    });
    const { body, headers } = signed(dmPayload("msg-unique-1"));
    const result = handleInbound({
      body,
      headers,
      config: cfg,
      nowSeconds: () => NOW,
      idempotencyStore: store,
    });
    expect(result.kind).toBe("dispatched");
    store.dispose();
  });

  test("duplicate delivery is skipped", () => {
    const store = createIdempotencyStore({
      ttlMs: 60_000,
      sweepIntervalMs: 999_999,
      nowMs: () => NOW * 1000,
    });
    const payload = dmPayload("msg-retry-1");
    const { body, headers } = signed(payload);
    // First call — dispatched
    const first = handleInbound({
      body,
      headers,
      config: cfg,
      nowSeconds: () => NOW,
      idempotencyStore: store,
    });
    expect(first.kind).toBe("dispatched");

    // Second call with same message id — duplicate
    const second = handleInbound({
      body,
      headers,
      config: cfg,
      nowSeconds: () => NOW,
      idempotencyStore: store,
    });
    expect(second.kind).toBe("skipped");
    if (second.kind === "skipped") {
      expect(second.reason).toBe("duplicate");
    }
    store.dispose();
  });

  test("different message ids are not deduplicated", () => {
    const store = createIdempotencyStore({
      ttlMs: 60_000,
      sweepIntervalMs: 999_999,
      nowMs: () => NOW * 1000,
    });
    const { body: b1, headers: h1 } = signed(dmPayload("msg-a"));
    const { body: b2, headers: h2 } = signed(dmPayload("msg-b"));

    const r1 = handleInbound({
      body: b1,
      headers: h1,
      config: cfg,
      nowSeconds: () => NOW,
      idempotencyStore: store,
    });
    const r2 = handleInbound({
      body: b2,
      headers: h2,
      config: cfg,
      nowSeconds: () => NOW,
      idempotencyStore: store,
    });
    expect(r1.kind).toBe("dispatched");
    expect(r2.kind).toBe("dispatched");
    store.dispose();
  });

  test("works without idempotency store (backward compat)", () => {
    const { body, headers } = signed(dmPayload("msg-no-store"));
    const r1 = handleInbound({
      body,
      headers,
      config: cfg,
      nowSeconds: () => NOW,
    });
    const r2 = handleInbound({
      body,
      headers,
      config: cfg,
      nowSeconds: () => NOW,
    });
    // Both dispatch because there's no dedup store.
    expect(r1.kind).toBe("dispatched");
    expect(r2.kind).toBe("dispatched");
  });

  test("logs duplicate events", () => {
    const store = createIdempotencyStore({
      ttlMs: 60_000,
      sweepIntervalMs: 999_999,
      nowMs: () => NOW * 1000,
    });
    const logs: Array<{ level: string; msg: string }> = [];
    const log = (level: "info" | "warn", msg: string) =>
      logs.push({ level, msg });

    const { body, headers } = signed(dmPayload("msg-log-test"));
    handleInbound({
      body,
      headers,
      config: cfg,
      nowSeconds: () => NOW,
      idempotencyStore: store,
      log,
    });
    handleInbound({
      body,
      headers,
      config: cfg,
      nowSeconds: () => NOW,
      idempotencyStore: store,
      log,
    });

    expect(logs.some((l) => l.msg === "thechat.inbound.duplicate")).toBe(true);
    store.dispose();
  });
});
