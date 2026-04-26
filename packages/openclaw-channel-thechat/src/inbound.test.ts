import { describe, test, expect } from "bun:test";
import { handleInbound } from "./inbound.js";
import { computeSignature } from "./signature.js";
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

function dmPayload(over: Partial<TheChatWebhookPayload> = {}): TheChatWebhookPayload {
  return {
    event: "direct_message",
    message: {
      id: "m1",
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
    ...over,
  };
}

describe("handleInbound — happy path", () => {
  test("dispatches a verified DM", () => {
    const { body, headers } = signed(dmPayload());
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
});

describe("handleInbound — verification failures", () => {
  test("rejects when signature is missing", () => {
    const { body } = signed(dmPayload());
    const r = handleInbound({
      body,
      headers: { "X-Webhook-Timestamp": String(NOW) },
      config: cfg,
      nowSeconds: () => NOW,
    });
    expect(r).toEqual({
      kind: "rejected",
      status: 400,
      reason: "missing_headers",
    });
  });

  test("rejects bad signature with 401", () => {
    const { body, headers } = signed(dmPayload());
    headers["X-Webhook-Signature"] = headers["X-Webhook-Signature"] + "00";
    const r = handleInbound({
      body,
      headers,
      config: cfg,
      nowSeconds: () => NOW,
    });
    expect(r).toEqual({
      kind: "rejected",
      status: 401,
      reason: "bad_signature",
    });
  });

  test("rejects stale timestamp with 401", () => {
    const { body, headers } = signed(dmPayload(), NOW - 10_000);
    const r = handleInbound({
      body,
      headers,
      config: cfg,
      nowSeconds: () => NOW,
    });
    expect(r).toEqual({
      kind: "rejected",
      status: 401,
      reason: "stale_timestamp",
    });
  });

  test("rejects payload addressed to a different bot", () => {
    const payload = dmPayload({
      bot: { id: "different-bot", userId: "other", name: "Other" },
    });
    const { body, headers } = signed(payload);
    const r = handleInbound({
      body,
      headers,
      config: cfg,
      nowSeconds: () => NOW,
    });
    expect(r).toEqual({
      kind: "rejected",
      status: 400,
      reason: "wrong_bot",
    });
  });

  test("rejects malformed JSON", () => {
    const sig = computeSignature({
      body: "not-json",
      timestamp: NOW,
      secret: cfg.webhookSecret,
    });
    const r = handleInbound({
      body: "not-json",
      headers: {
        "X-Webhook-Timestamp": String(NOW),
        "X-Webhook-Signature": sig,
      },
      config: cfg,
      nowSeconds: () => NOW,
    });
    expect(r).toEqual({
      kind: "rejected",
      status: 400,
      reason: "invalid_json",
    });
  });

  test("case-insensitive header lookup works", () => {
    const { body, headers: h } = signed(dmPayload());
    const r = handleInbound({
      body,
      headers: {
        "x-webhook-timestamp": h["X-Webhook-Timestamp"],
        "x-webhook-signature": h["X-Webhook-Signature"],
      },
      config: cfg,
      nowSeconds: () => NOW,
    });
    expect(r.kind).toBe("dispatched");
  });
});

describe("handleInbound — gating skips", () => {
  test("skips when sender is on no allowlist match", () => {
    const { body, headers } = signed(dmPayload());
    const r = handleInbound({
      body,
      headers,
      config: { ...cfg, allowFrom: ["someone-else"] },
      nowSeconds: () => NOW,
    });
    expect(r.kind).toBe("skipped");
    if (r.kind === "skipped") expect(r.reason).toBe("sender_not_allowed");
  });

  test("skips a DM from another bot by default", () => {
    const payload = dmPayload({
      message: {
        ...dmPayload().message,
        senderId: "user-bot-2",
        senderType: "bot",
      },
    });
    const { body, headers } = signed(payload);
    const r = handleInbound({
      body,
      headers,
      config: cfg,
      nowSeconds: () => NOW,
    });
    expect(r.kind).toBe("skipped");
    if (r.kind === "skipped") expect(r.reason).toBe("other_bot_blocked");
  });
});

describe("handleInbound — observability hook", () => {
  test("calls log on dispatch and skip", () => {
    const logs: Array<{ level: string; msg: string }> = [];
    const log = (level: "info" | "warn", msg: string) =>
      logs.push({ level, msg });

    const { body, headers } = signed(dmPayload());
    handleInbound({ body, headers, config: cfg, nowSeconds: () => NOW, log });
    expect(logs.some((l) => l.msg === "thechat.inbound.dispatched")).toBe(true);

    logs.length = 0;
    const sender2 = dmPayload({
      message: { ...dmPayload().message, senderId: "blocked" },
    });
    const second = signed(sender2);
    handleInbound({
      body: second.body,
      headers: second.headers,
      config: { ...cfg, allowFrom: ["x"] },
      nowSeconds: () => NOW,
      log,
    });
    expect(logs.some((l) => l.msg === "thechat.inbound.skipped")).toBe(true);
  });
});
