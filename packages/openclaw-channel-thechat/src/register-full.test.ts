import { describe, test, expect } from "bun:test";
import { Readable } from "node:stream";
import entry from "../index.js";
import { computeSignature } from "./signature.js";
import type { TheChatWebhookPayload } from "./types.js";

const NOW = Math.floor(Date.now() / 1000);

const cfg = {
  channels: {
    thechat: {
      baseUrl: "https://chat.example",
      botId: "bot-1",
      botUserId: "user-bot-1",
      apiKey: "bot_x",
      webhookSecret: "whsec_secretvalue",
    },
  },
};

function groupMentionPayload(): TheChatWebhookPayload {
  return {
    event: "mention",
    message: {
      id: "msg-1",
      content: "hey @Bot please respond",
      conversationId: "conv-2",
      senderId: "user-human-1",
      senderName: "Alice",
      senderType: "human",
      createdAt: new Date(NOW * 1000).toISOString(),
    },
    conversation: {
      id: "conv-2",
      type: "group",
      kind: "channel",
      name: "general",
      workspaceId: "ws-1",
    },
    workspace: { id: "ws-1", name: "WS" },
    bot: { id: "bot-1", userId: "user-bot-1", name: "Bot" },
  };
}

function signBody(payload: TheChatWebhookPayload): string {
  return JSON.stringify(payload);
}

function headersFor(body: string): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-webhook-timestamp": String(NOW),
    "x-webhook-signature": computeSignature({
      body,
      timestamp: NOW,
      secret: cfg.channels.thechat.webhookSecret,
    }),
  };
}

function makeReq(
  body: string,
  headers: Record<string, string> = {},
  method = "POST"
): any {
  const req = Readable.from(body ? [body] : []) as any;
  req.method = method;
  req.headers = headers;
  req.socket = { remoteAddress: "127.0.0.1" };
  return req;
}

function makeRes(): any {
  const headers: Record<string, string> = {};
  const finishCallbacks: Array<() => void> = [];
  return {
    statusCode: 200,
    headers,
    body: "",
    writableEnded: false,
    setHeader(name: string, value: string) {
      headers[name] = value;
    },
    once(event: string, cb: () => void) {
      if (event === "finish") finishCallbacks.push(cb);
      return this;
    },
    end(chunk?: string | Buffer, cb?: () => void) {
      if (chunk) this.body += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
      this.writableEnded = true;
      cb?.();
      for (const finish of finishCallbacks.splice(0)) {
        finish();
      }
      return this;
    },
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out waiting for async webhook dispatch");
}

function registerTestRoute() {
  let route: any = null;
  const resolvedRoutes: unknown[] = [];
  const recordedSessions: unknown[] = [];
  const api: any = {
    registrationMode: "full",
    config: cfg,
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
    registerChannel() {},
    registerHttpRoute(nextRoute: any) {
      route = nextRoute;
    },
    runtime: {
      channel: {
        routing: {
          resolveAgentRoute(params: any) {
            resolvedRoutes.push(params);
            return {
              accountId: params.accountId,
              agentId: "agent-default",
              sessionKey: `agent-default:${params.peer.kind}:${params.peer.id}`,
            };
          },
        },
        session: {
          resolveStorePath() {
            return "/home/bruno/.openclaw/workspace/tmp/thechat-register-full-test.json";
          },
          readSessionUpdatedAt() {
            return undefined;
          },
          async recordInboundSession(params: unknown) {
            recordedSessions.push(params);
          },
        },
        reply: {
          resolveEnvelopeFormatOptions() {
            return {};
          },
          formatAgentEnvelope({ channel, from, body }: any) {
            return `[${channel}] ${from}: ${body}`;
          },
          finalizeInboundContext(ctx: unknown) {
            return ctx;
          },
          async dispatchReplyWithBufferedBlockDispatcher({ dispatcherOptions }: any) {
            await dispatcherOptions.deliver({ text: "agent reply" });
          },
        },
      },
    },
  };
  (entry as any).register(api);
  return { route, resolvedRoutes, recordedSessions };
}

describe("registerFull webhook handler", () => {
  test("dispatches group mentions through the OpenClaw channel runtime fallback", async () => {
    const { route, resolvedRoutes, recordedSessions } = registerTestRoute();
    const body = signBody(groupMentionPayload());
    const res = makeRes();
    const outbound: Array<{ url: string; body: unknown }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      outbound.push({
        url: String(url),
        body: JSON.parse(String(init?.body ?? "{}")),
      });
      return new Response(
        JSON.stringify({ id: "out-1", conversationId: "conv-2" }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as typeof fetch;

    try {
      const handled = await route.handler(makeReq(body, headersFor(body)), res);
      expect(handled).toBe(true);
      expect(res.statusCode).toBe(202);
      expect(res.body).toBe("accepted");

      await waitFor(() => outbound.length === 1);
      expect(resolvedRoutes).toHaveLength(1);
      expect((resolvedRoutes[0] as any).peer).toEqual({
        kind: "group",
        id: "conv-2",
      });
      expect(recordedSessions).toHaveLength(1);
      expect(outbound[0].url).toBe("https://chat.example/messages/conv-2");
      expect(outbound[0].body).toEqual({ content: "agent reply" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("rejects non-POST webhook requests before reading a body", async () => {
    const { route } = registerTestRoute();
    const res = makeRes();
    const handled = await route.handler(makeReq("", {}, "GET"), res);
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(405);
    expect(res.headers.Allow).toBe("POST");
    expect(res.body).toBe("Method Not Allowed");
  });

  test("rejects POST webhook requests without a JSON content type", async () => {
    const { route } = registerTestRoute();
    const body = signBody(groupMentionPayload());
    const missingContentTypeRes = makeRes();
    const headers = headersFor(body);
    delete headers["content-type"];
    const handled = await route.handler(makeReq(body, headers), missingContentTypeRes);
    expect(handled).toBe(true);
    expect(missingContentTypeRes.statusCode).toBe(415);
    expect(missingContentTypeRes.body).toBe("Unsupported Media Type");
  });
});
