import { afterEach, describe, expect, test } from "bun:test";
import {
  hermesRpcAuthenticatedUrl,
  listHermesRpcSessions,
  normalizeHermesRpcEndpoint,
} from "./hermes-rpc-client";

const servers: Array<{ stop(closeActiveConnections?: boolean): void }> = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

describe("Direct Hermes JSON-RPC client", () => {
  test("normalizes dashboard and WebSocket endpoints without embedding credentials", () => {
    expect(normalizeHermesRpcEndpoint("http://127.0.0.1:8642")).toBe(
      "ws://127.0.0.1:8642/api/ws",
    );
    expect(normalizeHermesRpcEndpoint("https://hermes.example/base/")).toBe(
      "wss://hermes.example/base/api/ws",
    );
    expect(normalizeHermesRpcEndpoint("wss://hermes.example/api/ws/")).toBe(
      "wss://hermes.example/api/ws",
    );
    expect(() => normalizeHermesRpcEndpoint("ftp://hermes.example")).toThrow(
      "http, https, ws, or wss",
    );
    expect(() =>
      normalizeHermesRpcEndpoint("wss://user:pass@hermes.example/api/ws"),
    ).toThrow("credentials");
    expect(() =>
      normalizeHermesRpcEndpoint("wss://hermes.example/api/ws?token=secret"),
    ).toThrow("query string");
  });

  test("keeps token auth separate from the persisted endpoint", () => {
    expect(
      hermesRpcAuthenticatedUrl(
        "https://hermes.example/base",
        "token with spaces",
      ),
    ).toBe(
      "wss://hermes.example/base/api/ws?token=token+with+spaces",
    );
  });

  test("opens the gateway and calls only session.list", async () => {
    let requestUrl = "";
    let requestFrame: Record<string, unknown> | null = null;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, server) {
        requestUrl = request.url;
        if (server.upgrade(request)) return;
        return new Response("WebSocket required", { status: 426 });
      },
      websocket: {
        message(socket, raw) {
          requestFrame = JSON.parse(String(raw));
          socket.send(
            JSON.stringify({
              jsonrpc: "2.0",
              method: "event",
              params: { type: "gateway.ready" },
            }),
          );
          socket.send(
            JSON.stringify({
              jsonrpc: "2.0",
              id: requestFrame!.id,
              result: {
                sessions: [
                  {
                    id: "session-1",
                    title: "Proxy proof",
                    preview: "The session list came through Hermes JSON-RPC.",
                    started_at: 1_788_000_000,
                    message_count: 7,
                    source: "thechat",
                  },
                ],
              },
            }),
          );
        },
      },
    });
    servers.push(server);

    const sessions = await listHermesRpcSessions(
      `http://127.0.0.1:${server.port}`,
      "gateway-secret",
    );

    expect(new URL(requestUrl).pathname).toBe("/api/ws");
    expect(new URL(requestUrl).searchParams.get("token")).toBe("gateway-secret");
    expect(requestFrame).toMatchObject({
      jsonrpc: "2.0",
      method: "session.list",
      params: { limit: 200 },
    });
    expect(sessions).toEqual([
      {
        id: "session-1",
        title: "Proxy proof",
        preview: "The session list came through Hermes JSON-RPC.",
        started_at: 1_788_000_000,
        message_count: 7,
        source: "thechat",
      },
    ]);
  });

  test("redacts the gateway token from upstream JSON-RPC errors", async () => {
    const secret = "never-print-this-token";
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, server) {
        if (server.upgrade(request)) return;
        return new Response("WebSocket required", { status: 426 });
      },
      websocket: {
        message(socket, raw) {
          const request = JSON.parse(String(raw));
          socket.send(
            JSON.stringify({
              jsonrpc: "2.0",
              id: request.id,
              error: {
                code: -32603,
                message: `gateway rejected token=${secret}`,
              },
            }),
          );
        },
      },
    });
    servers.push(server);

    await expect(
      listHermesRpcSessions(`http://127.0.0.1:${server.port}`, secret),
    ).rejects.toThrow("gateway rejected token=[redacted]");
  });
});
