import { describe, test, expect } from "bun:test";
import {
  buildSendRichMessageRequest,
  sendRichMessage,
} from "./outbound.js";
import type { TheChatChannelConfig, OutboundRichMessage } from "./types.js";

const cfg: TheChatChannelConfig = {
  baseUrl: "https://chat.example.com",
  botId: "bot-1",
  botUserId: "user-bot-1",
  apiKey: "bot_testkey",
  webhookSecret: "whsec_testsecret",
};

describe("buildSendRichMessageRequest", () => {
  test("builds request with text-only message", () => {
    const req = buildSendRichMessageRequest({
      config: cfg,
      to: "dm:conv-1",
      message: { content: "Hello world" },
    });
    expect(req.url).toBe("https://chat.example.com/messages/conv-1");
    expect(req.method).toBe("POST");
    expect(req.headers["Authorization"]).toBe("Bearer bot_testkey");
    const body = JSON.parse(req.body);
    expect(body.content).toBe("Hello world");
    expect(body.attachments).toBeUndefined();
  });

  test("includes attachments in the request body", () => {
    const message: OutboundRichMessage = {
      content: "See attached",
      attachments: [
        {
          mimeType: "image/png",
          url: "https://cdn.example.com/img.png",
          filename: "screenshot.png",
          sizeBytes: 12345,
          alt: "A screenshot",
        },
      ],
    };
    const req = buildSendRichMessageRequest({
      config: cfg,
      to: "channel:conv-2",
      message,
    });
    const body = JSON.parse(req.body);
    expect(body.attachments).toHaveLength(1);
    expect(body.attachments[0].mimeType).toBe("image/png");
    expect(body.attachments[0].url).toBe("https://cdn.example.com/img.png");
    expect(body.attachments[0].filename).toBe("screenshot.png");
    expect(body.attachments[0].sizeBytes).toBe(12345);
    expect(body.attachments[0].alt).toBe("A screenshot");
  });

  test("includes ephemeral flag", () => {
    const req = buildSendRichMessageRequest({
      config: cfg,
      to: "dm:conv-1",
      message: { content: "secret", ephemeral: true },
    });
    const body = JSON.parse(req.body);
    expect(body.ephemeral).toBe(true);
  });

  test("includes replyTo field", () => {
    const req = buildSendRichMessageRequest({
      config: cfg,
      to: "dm:conv-1",
      message: { content: "replying", replyTo: "msg-abc" },
    });
    const body = JSON.parse(req.body);
    expect(body.replyTo).toBe("msg-abc");
  });

  test("omits optional attachment fields when not provided", () => {
    const req = buildSendRichMessageRequest({
      config: cfg,
      to: "dm:conv-1",
      message: {
        content: "file",
        attachments: [
          { mimeType: "application/pdf", url: "https://x/f.pdf", filename: "f.pdf" },
        ],
      },
    });
    const body = JSON.parse(req.body);
    expect(body.attachments[0].sizeBytes).toBeUndefined();
    expect(body.attachments[0].alt).toBeUndefined();
  });

  test("allows empty content if attachments are present", () => {
    const req = buildSendRichMessageRequest({
      config: cfg,
      to: "dm:conv-1",
      message: {
        content: "",
        attachments: [
          { mimeType: "image/png", url: "https://x/i.png", filename: "i.png" },
        ],
      },
    });
    const body = JSON.parse(req.body);
    expect(body.content).toBe("");
    expect(body.attachments).toHaveLength(1);
  });

  test("throws when both content and attachments are empty", () => {
    expect(() =>
      buildSendRichMessageRequest({
        config: cfg,
        to: "dm:conv-1",
        message: { content: "" },
      })
    ).toThrow("must have content or at least one attachment");
  });

  test("throws on invalid target", () => {
    expect(() =>
      buildSendRichMessageRequest({
        config: cfg,
        to: "invalid-target",
        message: { content: "hi" },
      })
    ).toThrow("not a TheChat conversation id");
  });

  test("throws on attachment missing mimeType", () => {
    expect(() =>
      buildSendRichMessageRequest({
        config: cfg,
        to: "dm:conv-1",
        message: {
          content: "hi",
          attachments: [{ mimeType: "", url: "https://x", filename: "f" } as any],
        },
      })
    ).toThrow("attachment[0] missing mimeType");
  });

  test("throws on attachment missing url", () => {
    expect(() =>
      buildSendRichMessageRequest({
        config: cfg,
        to: "dm:conv-1",
        message: {
          content: "hi",
          attachments: [{ mimeType: "image/png", url: "", filename: "f" } as any],
        },
      })
    ).toThrow("attachment[0] missing url");
  });

  test("throws on attachment missing filename", () => {
    expect(() =>
      buildSendRichMessageRequest({
        config: cfg,
        to: "dm:conv-1",
        message: {
          content: "hi",
          attachments: [{ mimeType: "image/png", url: "https://x", filename: "" } as any],
        },
      })
    ).toThrow("attachment[0] missing filename");
  });

  test("strips trailing slash from baseUrl", () => {
    const req = buildSendRichMessageRequest({
      config: { ...cfg, baseUrl: "https://chat.example.com/" },
      to: "dm:conv-1",
      message: { content: "hi" },
    });
    expect(req.url).toBe("https://chat.example.com/messages/conv-1");
  });
});

describe("sendRichMessage", () => {
  test("sends rich message and returns result", async () => {
    const fetchImpl = (async (_url: string, _init: any) => ({
      ok: true,
      json: async () => ({ id: "msg-1", conversationId: "conv-1" }),
      text: async () => "",
    })) as unknown as typeof fetch;

    const result = await sendRichMessage({
      config: cfg,
      to: "dm:conv-1",
      message: {
        content: "hello",
        attachments: [
          { mimeType: "text/plain", url: "https://x/f.txt", filename: "f.txt" },
        ],
      },
      fetchImpl,
    });
    expect(result.messageId).toBe("msg-1");
    expect(result.conversationId).toBe("conv-1");
  });

  test("throws on non-2xx response", async () => {
    const fetchImpl = (async () => ({
      ok: false,
      status: 403,
      text: async () => "forbidden",
      json: async () => ({}),
    })) as unknown as typeof fetch;

    await expect(
      sendRichMessage({
        config: cfg,
        to: "dm:conv-1",
        message: { content: "hi" },
        fetchImpl,
      })
    ).rejects.toThrow("HTTP 403");
  });
});
