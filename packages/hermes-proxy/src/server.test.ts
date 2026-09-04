import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { encryptSecret } from "./secrets";
import {
  HERMES_PROXY_PROTOCOL,
  hermesProxyTicketProtocol,
} from "./protocol";
import { createHermesProxyServer } from "./server";
import { InMemoryHermesProxyTicketStore } from "./tickets";

const previousSecret = process.env.THECHAT_SECRET_KEY;
const previousAllowLoopback =
  process.env.THECHAT_HERMES_PROXY_ALLOW_LOOPBACK;

const servers: Array<{ stop(closeActiveConnections?: boolean): void }> = [];
const sockets: WebSocket[] = [];

beforeEach(() => {
  process.env.THECHAT_SECRET_KEY =
    "proxy-test-encryption-key-at-least-32-bytes";
  process.env.THECHAT_HERMES_PROXY_ALLOW_LOOPBACK = "true";
});

afterEach(() => {
  for (const socket of sockets.splice(0)) socket.close();
  for (const server of servers.splice(0)) server.stop(true);
});

afterAll(() => {
  if (previousSecret === undefined) delete process.env.THECHAT_SECRET_KEY;
  else process.env.THECHAT_SECRET_KEY = previousSecret;
  if (previousAllowLoopback === undefined) {
    delete process.env.THECHAT_HERMES_PROXY_ALLOW_LOOPBACK;
  } else {
    process.env.THECHAT_HERMES_PROXY_ALLOW_LOOPBACK = previousAllowLoopback;
  }
});

function connect(url: string, protocols: string[]): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, protocols);
    sockets.push(socket);
    socket.addEventListener("open", () => resolve(socket), { once: true });
    socket.addEventListener(
      "error",
      () => reject(new Error("WebSocket connection failed")),
      { once: true },
    );
  });
}

function nextMessage(socket: WebSocket): Promise<MessageEvent> {
  return new Promise((resolve) => {
    socket.addEventListener("message", resolve, { once: true });
  });
}

function nextClose(socket: WebSocket): Promise<CloseEvent> {
  return new Promise((resolve) => {
    socket.addEventListener("close", resolve, { once: true });
  });
}

describe("Hermes raw WebSocket proxy", () => {
  test("forwards opaque text and binary frames without interpreting RPC", async () => {
    const gatewayToken = "upstream-gateway-token";
    let upstreamRequestUrl = "";
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, server) {
        upstreamRequestUrl = request.url;
        if (server.upgrade(request)) return;
        return new Response("WebSocket required", { status: 426 });
      },
      websocket: {
        message(socket, message) {
          socket.send(message);
        },
      },
    });
    servers.push(upstream);

    const ticketStore = new InMemoryHermesProxyTicketStore();
    const issued = await ticketStore.issue({
      version: 1,
      botId: crypto.randomUUID(),
      conversationId: crypto.randomUUID(),
      endpoint: `ws://127.0.0.1:${upstream.port}/api/ws`,
      gatewayTokenEncrypted: encryptSecret(gatewayToken),
      userId: crypto.randomUUID(),
    });
    const proxy = createHermesProxyServer({
      hostname: "127.0.0.1",
      port: 0,
      ticketStore,
    });
    servers.push(proxy);

    const socket = await connect(
      `ws://127.0.0.1:${proxy.port}/hermes-proxy`,
      [HERMES_PROXY_PROTOCOL, hermesProxyTicketProtocol(issued.ticket)],
    );
    expect(socket.protocol).toBe(HERMES_PROXY_PROTOCOL);

    const textResponse = nextMessage(socket);
    socket.send("opaque:not-json:{still-forward-me}");
    expect((await textResponse).data).toBe("opaque:not-json:{still-forward-me}");

    socket.binaryType = "arraybuffer";
    const binaryResponse = nextMessage(socket);
    socket.send(Uint8Array.from([0, 1, 2, 127, 128, 255]));
    expect(Array.from(new Uint8Array((await binaryResponse).data))).toEqual([
      0,
      1,
      2,
      127,
      128,
      255,
    ]);

    const upstreamUrl = new URL(upstreamRequestUrl);
    expect(upstreamUrl.pathname).toBe("/api/ws");
    expect(upstreamUrl.searchParams.get("token")).toBe(gatewayToken);

    await expect(
      connect(`ws://127.0.0.1:${proxy.port}/hermes-proxy`, [
        HERMES_PROXY_PROTOCOL,
        hermesProxyTicketProtocol(issued.ticket),
      ]),
    ).rejects.toThrow("WebSocket connection failed");
  });

  test("limits concurrent tunnels per authorized user and releases the slot", async () => {
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, server) {
        if (server.upgrade(request)) return;
        return new Response("WebSocket required", { status: 426 });
      },
      websocket: { message() {} },
    });
    servers.push(upstream);

    const ticketStore = new InMemoryHermesProxyTicketStore();
    const input = {
      version: 1 as const,
      botId: crypto.randomUUID(),
      conversationId: crypto.randomUUID(),
      endpoint: `ws://127.0.0.1:${upstream.port}/api/ws`,
      gatewayTokenEncrypted: encryptSecret("gateway-token"),
      userId: crypto.randomUUID(),
    };
    const firstTicket = await ticketStore.issue(input);
    const secondTicket = await ticketStore.issue(input);
    const proxy = createHermesProxyServer({
      hostname: "127.0.0.1",
      maxConnectionsPerUser: 1,
      port: 0,
      ticketStore,
    });
    servers.push(proxy);
    const url = `ws://127.0.0.1:${proxy.port}/hermes-proxy`;

    const first = await connect(url, [
      HERMES_PROXY_PROTOCOL,
      hermesProxyTicketProtocol(firstTicket.ticket),
    ]);
    await expect(
      connect(url, [
        HERMES_PROXY_PROTOCOL,
        hermesProxyTicketProtocol(secondTicket.ticket),
      ]),
    ).rejects.toThrow("WebSocket connection failed");

    const firstClosed = nextClose(first);
    first.close();
    await firstClosed;
    await new Promise((resolve) => setTimeout(resolve, 10));

    const thirdTicket = await ticketStore.issue(input);
    const third = await connect(url, [
      HERMES_PROXY_PROTOCOL,
      hermesProxyTicketProtocol(thirdTicket.ticket),
    ]);
    expect(third.readyState).toBe(WebSocket.OPEN);
  });

  test("expires active tunnels so permissions are rechecked", async () => {
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, server) {
        if (server.upgrade(request)) return;
        return new Response("WebSocket required", { status: 426 });
      },
      websocket: { message() {} },
    });
    servers.push(upstream);

    const ticketStore = new InMemoryHermesProxyTicketStore();
    const issued = await ticketStore.issue({
      version: 1,
      botId: crypto.randomUUID(),
      conversationId: crypto.randomUUID(),
      endpoint: `ws://127.0.0.1:${upstream.port}/api/ws`,
      gatewayTokenEncrypted: encryptSecret("gateway-token"),
      userId: crypto.randomUUID(),
    });
    const proxy = createHermesProxyServer({
      hostname: "127.0.0.1",
      maxConnectionDurationMs: 20,
      port: 0,
      ticketStore,
    });
    servers.push(proxy);

    const socket = await connect(
      `ws://127.0.0.1:${proxy.port}/hermes-proxy`,
      [HERMES_PROXY_PROTOCOL, hermesProxyTicketProtocol(issued.ticket)],
    );
    const closed = await Promise.race([
      nextClose(socket),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 250)),
    ]);
    expect(closed).not.toBeNull();
    expect(closed?.code).toBe(1008);
    expect(closed?.reason).toBe("Hermes proxy authorization expired");
  });

  test("rejects upstream endpoints outside the configured origin policy", async () => {
    let upstreamConnections = 0;
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, server) {
        upstreamConnections += 1;
        if (server.upgrade(request)) return;
        return new Response("WebSocket required", { status: 426 });
      },
      websocket: { message() {} },
    });
    servers.push(upstream);

    const ticketStore = new InMemoryHermesProxyTicketStore();
    const issued = await ticketStore.issue({
      version: 1,
      botId: crypto.randomUUID(),
      conversationId: crypto.randomUUID(),
      endpoint: `ws://127.0.0.1:${upstream.port}/api/ws`,
      gatewayTokenEncrypted: encryptSecret("gateway-token"),
      userId: crypto.randomUUID(),
    });
    const proxy = createHermesProxyServer({
      endpointPolicy: { allowedOrigins: [], allowLoopback: false },
      hostname: "127.0.0.1",
      port: 0,
      ticketStore,
    });
    servers.push(proxy);

    const socket = new WebSocket(
      `ws://127.0.0.1:${proxy.port}/hermes-proxy`,
      [HERMES_PROXY_PROTOCOL, hermesProxyTicketProtocol(issued.ticket)],
    );
    sockets.push(socket);
    const closed = await Promise.race([
      nextClose(socket),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 250)),
    ]);
    expect(closed).not.toBeNull();
    expect(closed?.code).toBe(1011);
    expect(upstreamConnections).toBe(0);
  });

  test("rejects missing tickets and closes when credentials cannot decrypt", async () => {
    const ticketStore = new InMemoryHermesProxyTicketStore();
    const proxy = createHermesProxyServer({
      hostname: "127.0.0.1",
      port: 0,
      ticketStore,
    });
    servers.push(proxy);

    const response = await fetch(
      `http://127.0.0.1:${proxy.port}/hermes-proxy`,
    );
    expect(response.status).toBe(401);

    const issued = await ticketStore.issue({
      version: 1,
      botId: crypto.randomUUID(),
      conversationId: crypto.randomUUID(),
      endpoint: "ws://127.0.0.1:1/api/ws",
      gatewayTokenEncrypted: "invalid-envelope",
      userId: crypto.randomUUID(),
    });
    const socket = await connect(
      `ws://127.0.0.1:${proxy.port}/hermes-proxy`,
      [HERMES_PROXY_PROTOCOL, hermesProxyTicketProtocol(issued.ticket)],
    );
    const closed = await nextClose(socket);
    expect(closed.code).toBe(1011);
    expect(closed.reason).not.toContain("invalid-envelope");
  });
});
