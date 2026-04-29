import { describe, test, expect } from "bun:test";
import { deriveSessionMapping, parseTarget } from "./session.js";
import type { TheChatWebhookPayload } from "./types.js";

function payload(over: Partial<TheChatWebhookPayload["conversation"]>): TheChatWebhookPayload {
  return {
    event: "direct_message",
    message: {
      id: "m1",
      content: "hi",
      conversationId: "conv-1",
      senderId: "user-1",
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
      ...over,
    },
    workspace: { id: "ws-1", name: "WS" },
    bot: { id: "bot-1", userId: "user-bot-1", name: "Bot" },
  };
}

describe("deriveSessionMapping", () => {
  test("maps a DM conversation to dm:<id>", () => {
    const r = deriveSessionMapping(payload({}));
    expect(r.to).toBe("dm:conv-1");
    expect(r.chatType).toBe("direct");
    expect(r.sessionKey).toBe("thechat:ws-1:dm:conv-1");
  });

  test("maps a channel conversation to channel:<id>", () => {
    const r = deriveSessionMapping(
      payload({
        id: "conv-2",
        type: "group",
        kind: "channel",
        name: "general",
      })
    );
    expect(r.to).toBe("channel:conv-2");
    expect(r.chatType).toBe("group");
    expect(r.sessionKey).toBe("thechat:ws-1:channel:conv-2");
  });

  test("falls back to 'global' workspace scope when workspaceId is null", () => {
    const r = deriveSessionMapping(payload({ workspaceId: null }));
    expect(r.sessionKey).toBe("thechat:global:dm:conv-1");
  });

  test("identical input always produces identical session key", () => {
    const a = deriveSessionMapping(payload({}));
    const b = deriveSessionMapping(payload({}));
    expect(a.sessionKey).toBe(b.sessionKey);
  });
});

describe("parseTarget", () => {
  test("parses a DM target", () => {
    expect(parseTarget("dm:abc-123")).toEqual({
      kind: "dm",
      conversationId: "abc-123",
    });
  });

  test("parses a channel target", () => {
    expect(parseTarget("channel:xyz")).toEqual({
      kind: "channel",
      conversationId: "xyz",
    });
  });

  test("rejects targets without a known prefix", () => {
    expect(parseTarget("workspace:foo")).toBeNull();
    expect(parseTarget("foo")).toBeNull();
    expect(parseTarget("")).toBeNull();
  });

  test("round-trips through deriveSessionMapping", () => {
    const mapping = deriveSessionMapping(payload({}));
    expect(parseTarget(mapping.to)?.conversationId).toBe("conv-1");
  });
});
