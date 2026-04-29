import { describe, test, expect } from "bun:test";
import { shouldDispatch } from "./gating.js";
import type { TheChatChannelConfig, TheChatWebhookPayload } from "./types.js";

const baseConfig: TheChatChannelConfig = {
  baseUrl: "https://chat.example",
  botId: "bot-1",
  botUserId: "user-bot-1",
  apiKey: "bot_x",
  webhookSecret: "whsec_x",
};

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
      createdAt: new Date().toISOString(),
    },
    conversation: {
      id: "conv-1",
      type: "direct",
      kind: "dm",
      name: null,
      workspaceId: "ws-1",
    },
    workspace: { id: "ws-1", name: "Test" },
    bot: { id: "bot-1", userId: "user-bot-1", name: "Bot" },
    ...over,
  };
}

function mentionPayload(
  over: Partial<TheChatWebhookPayload> = {}
): TheChatWebhookPayload {
  return {
    event: "mention",
    message: {
      id: "m2",
      content: "hey @Bot",
      conversationId: "conv-2",
      senderId: "user-human-1",
      senderName: "Alice",
      senderType: "human",
      createdAt: new Date().toISOString(),
    },
    conversation: {
      id: "conv-2",
      type: "group",
      kind: "channel",
      name: "general",
      workspaceId: "ws-1",
    },
    workspace: { id: "ws-1", name: "Test" },
    bot: { id: "bot-1", userId: "user-bot-1", name: "Bot" },
    ...over,
  };
}

describe("shouldDispatch — DMs", () => {
  test("dispatches a human DM", () => {
    expect(shouldDispatch(dmPayload(), baseConfig)).toEqual({ dispatch: true });
  });

  test("drops the bot's own message even if it slipped through", () => {
    const r = shouldDispatch(
      dmPayload({
        message: {
          ...dmPayload().message,
          senderId: baseConfig.botUserId,
        },
      }),
      baseConfig
    );
    expect(r).toEqual({ dispatch: false, reason: "own_message" });
  });

  test("drops a DM from another bot by default", () => {
    const r = shouldDispatch(
      dmPayload({
        message: {
          ...dmPayload().message,
          senderId: "user-bot-2",
          senderType: "bot",
        },
      }),
      baseConfig
    );
    expect(r).toEqual({ dispatch: false, reason: "other_bot_blocked" });
  });

  test("allows bot DM when allowOtherBots is true", () => {
    const r = shouldDispatch(
      dmPayload({
        message: {
          ...dmPayload().message,
          senderId: "user-bot-2",
          senderType: "bot",
        },
      }),
      { ...baseConfig, allowOtherBots: true }
    );
    expect(r).toEqual({ dispatch: true });
  });
});

describe("shouldDispatch — channels", () => {
  test("dispatches a channel mention from a human", () => {
    expect(shouldDispatch(mentionPayload(), baseConfig)).toEqual({
      dispatch: true,
    });
  });

  test("drops a channel message from another bot", () => {
    const r = shouldDispatch(
      mentionPayload({
        message: {
          ...mentionPayload().message,
          senderId: "user-bot-2",
          senderType: "bot",
        },
      }),
      baseConfig
    );
    expect(r).toEqual({ dispatch: false, reason: "other_bot_blocked" });
  });
});

describe("shouldDispatch — allowlist", () => {
  test("drops a sender not on the allowlist", () => {
    const r = shouldDispatch(dmPayload(), {
      ...baseConfig,
      allowFrom: ["user-someone-else"],
    });
    expect(r).toEqual({ dispatch: false, reason: "sender_not_allowed" });
  });

  test("dispatches a sender on the allowlist", () => {
    const r = shouldDispatch(dmPayload(), {
      ...baseConfig,
      allowFrom: ["user-human-1", "user-someone-else"],
    });
    expect(r).toEqual({ dispatch: true });
  });

  test("empty allowFrom array means everyone is allowed", () => {
    expect(
      shouldDispatch(dmPayload(), { ...baseConfig, allowFrom: [] })
    ).toEqual({ dispatch: true });
  });
});

describe("shouldDispatch — unknown event", () => {
  test("drops unknown event types", () => {
    const r = shouldDispatch(
      dmPayload({ event: "nope" as any }),
      baseConfig
    );
    expect(r).toEqual({ dispatch: false, reason: "unknown_event" });
  });
});
