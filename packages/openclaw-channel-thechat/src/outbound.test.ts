import { describe, test, expect } from "bun:test";
import { buildSendTextRequest, sendText } from "./outbound.js";
import type { TheChatChannelConfig } from "./types.js";

const cfg: TheChatChannelConfig = {
  baseUrl: "https://chat.example.com",
  botId: "bot-1",
  botUserId: "user-bot-1",
  apiKey: "bot_abcdef",
  webhookSecret: "whsec_x",
};

describe("buildSendTextRequest", () => {
  test("targets POST /messages/:conversationId", () => {
    const req = buildSendTextRequest({
      config: cfg,
      to: "channel:conv-99",
      text: "hello",
    });
    expect(req.method).toBe("POST");
    expect(req.url).toBe("https://chat.example.com/messages/conv-99");
  });

  test("includes Bearer auth and JSON content-type", () => {
    const req = buildSendTextRequest({
      config: cfg,
      to: "dm:conv-1",
      text: "hi",
    });
    expect(req.headers.Authorization).toBe("Bearer bot_abcdef");
    expect(req.headers["Content-Type"]).toBe("application/json");
  });

  test("trims trailing slashes from baseUrl", () => {
    const req = buildSendTextRequest({
      config: { ...cfg, baseUrl: "https://chat.example.com////" },
      to: "dm:conv-1",
      text: "hi",
    });
    expect(req.url).toBe("https://chat.example.com/messages/conv-1");
  });

  test("encodes the body as JSON {content}", () => {
    const req = buildSendTextRequest({
      config: cfg,
      to: "dm:conv-1",
      text: "hi there",
    });
    expect(JSON.parse(req.body)).toEqual({ content: "hi there" });
  });

  test("trims surrounding whitespace from the text", () => {
    const req = buildSendTextRequest({
      config: cfg,
      to: "dm:conv-1",
      text: "   padded   ",
    });
    expect(JSON.parse(req.body)).toEqual({ content: "padded" });
  });

  test("rejects targets that aren't a TheChat conversation", () => {
    expect(() =>
      buildSendTextRequest({ config: cfg, to: "slack:abc", text: "hi" })
    ).toThrow(/not a TheChat conversation/);
  });

  test("rejects empty text", () => {
    expect(() =>
      buildSendTextRequest({ config: cfg, to: "dm:1", text: "  " })
    ).toThrow(/empty/);
  });
});

describe("sendText", () => {
  test("returns the assigned message id on a 200 response", async () => {
    const fetchImpl = async (url: any, init: any) => {
      expect(url).toBe("https://chat.example.com/messages/conv-1");
      expect(init.method).toBe("POST");
      expect(init.headers.Authorization).toBe("Bearer bot_abcdef");
      expect(JSON.parse(init.body)).toEqual({ content: "hi" });
      return new Response(
        JSON.stringify({
          id: "msg-1",
          conversationId: "conv-1",
          senderId: "user-bot-1",
          senderName: "Bot",
          content: "hi",
          createdAt: new Date().toISOString(),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };
    const r = await sendText({
      config: cfg,
      to: "dm:conv-1",
      text: "hi",
      fetchImpl: fetchImpl as any,
    });
    expect(r.messageId).toBe("msg-1");
    expect(r.conversationId).toBe("conv-1");
  });

  test("throws on non-2xx status", async () => {
    const fetchImpl = async () =>
      new Response("nope", { status: 401 });
    await expect(
      sendText({
        config: cfg,
        to: "dm:conv-1",
        text: "hi",
        fetchImpl: fetchImpl as any,
      })
    ).rejects.toThrow(/HTTP 401/);
  });

  test("throws when response is missing required fields", async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ status: "ok" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    await expect(
      sendText({
        config: cfg,
        to: "dm:conv-1",
        text: "hi",
        fetchImpl: fetchImpl as any,
      })
    ).rejects.toThrow(/malformed/);
  });
});
