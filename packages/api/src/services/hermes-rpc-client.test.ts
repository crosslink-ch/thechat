import { describe, expect, test } from "bun:test";
import {
  HermesRpcClient,
  HermesRpcError,
  hermesRpcAuthenticatedUrl,
  normalizeHermesRpcEndpoint,
  redactHermesRpcText,
  type HermesRpcWebSocketLike,
} from "./hermes-rpc-client";

describe("HermesRpcClient endpoint handling", () => {
  test("normalizes dashboard bases, WebSocket URLs, host-only values, and api/ws paths", () => {
    expect(normalizeHermesRpcEndpoint("localhost:8642")).toBe("ws://localhost:8642/api/ws");
    expect(normalizeHermesRpcEndpoint("http://localhost:8642/")).toBe("ws://localhost:8642/api/ws");
    expect(normalizeHermesRpcEndpoint("https://hermes.example/base")).toBe("wss://hermes.example/base/api/ws");
    expect(normalizeHermesRpcEndpoint("wss://hermes.example/api/ws/")).toBe("wss://hermes.example/api/ws");
  });

  test("rejects secret-bearing and unsupported endpoint forms", () => {
    expect(() => normalizeHermesRpcEndpoint("ftp://hermes.example")).toThrow("http, https, ws, or wss");
    expect(() => normalizeHermesRpcEndpoint("ws://user:pass@hermes.example/api/ws")).toThrow("credentials");
    expect(() => normalizeHermesRpcEndpoint("ws://hermes.example/api/ws?token=raw")).toThrow("query string");
    expect(() => normalizeHermesRpcEndpoint("ws://hermes.example/api/ws/extra")).toThrow(
      "path must end with /api/ws",
    );
  });

  test("adds persistent token auth separately and redacts it from diagnostics", () => {
    const secret = "gateway-token-super-secret";
    expect(hermesRpcAuthenticatedUrl("https://hermes.example", secret)).toBe(
      "wss://hermes.example/api/ws?token=gateway-token-super-secret",
    );
    expect(redactHermesRpcText(`failed wss://host/api/ws?token=${secret}`, secret)).toBe(
      "failed wss://host/api/ws?token=[redacted]",
    );
  });
});

describe("HermesRpcClient transport", () => {
  test("correlates concurrent results arriving out of order", async () => {
    const socket = new FakeSocket();
    const client = connectedClient(socket);
    await client.connect();

    const first = client.request<{ value: string }>("first");
    const second = client.request<{ value: string }>("second");
    const [firstFrame, secondFrame] = socket.sentFrames();
    socket.message({ jsonrpc: "2.0", id: secondFrame.id, result: { value: "two" } });
    socket.message({ jsonrpc: "2.0", id: firstFrame.id, result: { value: "one" } });

    expect(await first).toEqual({ value: "one" });
    expect(await second).toEqual({ value: "two" });
    client.close();
  });

  test("delivers generic upstream notifications including gateway.ready", async () => {
    const socket = new FakeSocket();
    const client = connectedClient(socket);
    const events: string[] = [];
    const ready: string[] = [];
    client.onEvent((event) => events.push(event.type));
    client.on("gateway.ready", (event) => ready.push(event.type));
    await client.connect();

    socket.message({
      jsonrpc: "2.0",
      method: "event",
      params: { type: "gateway.ready", payload: { version: "test" } },
    });
    socket.message({
      jsonrpc: "2.0",
      method: "event",
      params: { type: "tool.start", session_id: "runtime-1", payload: { tool_id: "tool-1" } },
    });

    expect(events).toEqual(["gateway.ready", "tool.start"]);
    expect(ready).toEqual(["gateway.ready"]);
    client.close();
  });

  test("surfaces redacted JSON-RPC errors", async () => {
    const socket = new FakeSocket();
    const secret = "do-not-leak";
    const client = connectedClient(socket, { gatewayToken: secret });
    await client.connect();
    const request = client.request("session.list");
    const [frame] = socket.sentFrames();
    socket.message({
      jsonrpc: "2.0",
      id: frame.id,
      error: { code: -32603, message: `backend rejected token=${secret}` },
    });
    await expect(request).rejects.toMatchObject({
      name: "HermesRpcError",
      code: -32603,
      message: "backend rejected token=[redacted]",
    });
    client.close();
  });

  test("times out requests and ignores late results", async () => {
    const socket = new FakeSocket();
    const client = connectedClient(socket, { requestTimeoutMs: 5 });
    await client.connect();
    const request = client.request("session.list");
    const [frame] = socket.sentFrames();
    await expect(request).rejects.toThrow("request timed out: session.list");
    socket.message({ jsonrpc: "2.0", id: frame.id, result: { sessions: [] } });
    client.close();
  });

  test("rejects pending work and removes socket listeners on close", async () => {
    const socket = new FakeSocket();
    const client = connectedClient(socket);
    await client.connect();
    const pending = client.request("session.list");
    expect(socket.listenerCount("message")).toBe(1);
    client.close();
    await expect(pending).rejects.toThrow("connection closed");
    expect(socket.listenerCount("message")).toBe(0);
    expect(socket.listenerCount("close")).toBe(0);
    expect(socket.closed).toBe(true);
  });

  test("rejects and removes handshake listeners when explicitly closed before open", async () => {
    const socket = new FakeSocket();
    const client = new HermesRpcClient("http://hermes.test:8642", null, {
      connectTimeoutMs: 10_000,
      socketFactory: () => socket,
    });
    const connecting = client.connect();
    expect(socket.listenerCount("open")).toBe(1);
    expect(socket.listenerCount("close")).toBe(1);

    client.close();

    await expect(connecting).rejects.toThrow("connection closed");
    expect(socket.listenerCount("open")).toBe(0);
    expect(socket.listenerCount("close")).toBe(0);
    expect(socket.listenerCount("error")).toBe(0);
    expect(socket.closed).toBe(true);
  });

  test("cleans an aborted request without closing the connection", async () => {
    const socket = new FakeSocket();
    const client = connectedClient(socket);
    await client.connect();
    const controller = new AbortController();
    const pending = client.request("session.history", {}, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });

    const next = client.request("session.list");
    const frame = socket.sentFrames().at(-1)!;
    socket.message({ jsonrpc: "2.0", id: frame.id, result: { sessions: [] } });
    expect(await next).toEqual({ sessions: [] });
    client.close();
  });

  test("uses the exact upstream history and interrupt method parameters", async () => {
    const socket = new FakeSocket();
    const client = connectedClient(socket);
    await client.connect();

    const history = client.sessionHistory("runtime-session");
    const historyFrame = socket.sentFrames().at(-1)!;
    expect(historyFrame).toMatchObject({
      method: "session.history",
      params: { session_id: "runtime-session" },
    });
    socket.message({ jsonrpc: "2.0", id: historyFrame.id, result: { count: 0, messages: [] } });
    expect(await history).toEqual({ count: 0, messages: [] });

    const interrupt = client.interrupt("runtime-session");
    const interruptFrame = socket.sentFrames().at(-1)!;
    expect(interruptFrame).toMatchObject({
      method: "session.interrupt",
      params: { session_id: "runtime-session" },
    });
    socket.message({ jsonrpc: "2.0", id: interruptFrame.id, result: { status: "interrupted" } });
    expect(await interrupt).toEqual({ status: "interrupted" });
    client.close();
  });

  test("opts short-lived create and resume runtimes into close-on-disconnect", async () => {
    const socket = new FakeSocket();
    const client = connectedClient(socket);
    await client.connect();

    const created = client.sessionCreate();
    const createFrame = socket.sentFrames().at(-1)!;
    expect(createFrame).toMatchObject({
      method: "session.create",
      params: { source: "thechat", close_on_disconnect: true },
    });
    socket.message({
      jsonrpc: "2.0",
      id: createFrame.id,
      result: {
        session_id: "runtime-new",
        stored_session_id: "stored-new",
        message_count: 0,
        messages: [],
      },
    });
    await created;

    const resumed = client.sessionResume("stored-existing");
    const resumeFrame = socket.sentFrames().at(-1)!;
    expect(resumeFrame).toMatchObject({
      method: "session.resume",
      params: {
        session_id: "stored-existing",
        omit_messages: true,
        close_on_disconnect: true,
      },
    });
    socket.message({
      jsonrpc: "2.0",
      id: resumeFrame.id,
      result: { session_id: "runtime-existing", resumed: "stored-existing" },
    });
    await resumed;
    client.close();
  });
});

function connectedClient(
  socket: FakeSocket,
  options: { gatewayToken?: string; requestTimeoutMs?: number } = {},
) {
  return new HermesRpcClient("http://hermes.test:8642", options.gatewayToken, {
    requestTimeoutMs: options.requestTimeoutMs,
    socketFactory: () => {
      queueMicrotask(() => socket.emit("open", {}));
      return socket;
    },
  });
}

class FakeSocket implements HermesRpcWebSocketLike {
  readyState = 0;
  closed = false;
  private readonly listeners = new Map<string, Set<(event: any) => void>>();
  private readonly sent: string[] = [];

  addEventListener(type: string, handler: (event: any) => void) {
    const handlers = this.listeners.get(type) ?? new Set();
    handlers.add(handler);
    this.listeners.set(type, handlers);
  }

  removeEventListener(type: string, handler: (event: any) => void) {
    this.listeners.get(type)?.delete(handler);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.closed = true;
    this.readyState = 3;
  }

  emit(type: string, event: any) {
    if (type === "open") this.readyState = 1;
    for (const handler of this.listeners.get(type) ?? []) handler(event);
  }

  message(frame: unknown) {
    this.emit("message", { data: JSON.stringify(frame) });
  }

  sentFrames() {
    return this.sent.map((value) => JSON.parse(value) as Record<string, any>);
  }

  listenerCount(type: string) {
    return this.listeners.get(type)?.size ?? 0;
  }
}
