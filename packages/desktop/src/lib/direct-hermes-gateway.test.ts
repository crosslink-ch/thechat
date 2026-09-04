import { describe, expect, test, vi } from "vitest";
import {
  connectDirectHermesGateway,
  type DirectHermesProxyTicket,
} from "./direct-hermes-gateway";

class FakeSocket extends EventTarget {
  static readonly OPEN = 1;
  readyState = 0;
  sent: string[] = [];

  open() {
    this.readyState = FakeSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }

  send(value: string) {
    this.sent.push(value);
    const request = JSON.parse(value) as { id: string };
    queueMicrotask(() => {
      this.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            result: { state: "idle" },
          }),
        }),
      );
    });
  }

  close() {
    this.readyState = 3;
    this.dispatchEvent(new CloseEvent("close", { code: 1000 }));
  }
}

const ticket: DirectHermesProxyTicket = {
  proxyUrl: "wss://api.example.test/hermes-proxy",
  ticket: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
};

describe("Direct Hermes gateway connection", () => {
  test("mints a proxy ticket and carries arbitrary Hermes RPC in the desktop", async () => {
    const issueTicket = vi.fn(async () => ticket);
    let socketUrl = "";
    let socketProtocols: string[] = [];
    const socket = new FakeSocket();

    const clientPromise = connectDirectHermesGateway({
      issueTicket,
      socketFactory(url, protocols) {
        socketUrl = url;
        socketProtocols = protocols;
        queueMicrotask(() => socket.open());
        return socket as unknown as WebSocket;
      },
    });
    const client = await clientPromise;
    const status = await client.request<{ state: string }>(
      "session.status",
      { session_id: "session-1" },
    );

    expect(issueTicket).toHaveBeenCalledOnce();
    expect(socketUrl).toBe(ticket.proxyUrl);
    expect(socketProtocols).toEqual([
      "thechat-hermes-proxy-v1",
      `thechat-ticket.${ticket.ticket}`,
    ]);
    expect(JSON.parse(socket.sent[0])).toMatchObject({
      jsonrpc: "2.0",
      method: "session.status",
      params: { session_id: "session-1" },
    });
    expect(status).toEqual({ state: "idle" });
    client.close();
  });

  test("stops before ticket issuance when the caller is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const issueTicket = vi.fn(async () => ticket);
    const socketFactory = vi.fn();

    await expect(
      connectDirectHermesGateway({
        issueTicket,
        signal: controller.signal,
        socketFactory,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(issueTicket).not.toHaveBeenCalled();
    expect(socketFactory).not.toHaveBeenCalled();
  });

  test("closes a connecting socket when the caller aborts", async () => {
    const controller = new AbortController();
    const socket = new FakeSocket();
    const socketFactory = vi.fn(() => socket as unknown as WebSocket);
    const connection = connectDirectHermesGateway({
      issueTicket: async () => ticket,
      signal: controller.signal,
      socketFactory,
    });

    await vi.waitFor(() => expect(socketFactory).toHaveBeenCalledOnce());
    controller.abort();

    await expect(connection).rejects.toMatchObject({ name: "AbortError" });
    expect(socket.readyState).toBe(3);
  });

  test.each([
    {
      name: "malformed capability",
      ticket: {
        ticket: "short",
        proxyUrl: "ws://proxy.example/hermes-proxy",
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
    },
    {
      name: "expired capability",
      ticket: {
        ticket: "b".repeat(43),
        proxyUrl: "ws://proxy.example/hermes-proxy",
        expiresAt: "2000-01-01T00:00:00.000Z",
      },
    },
    {
      name: "non-WebSocket proxy URL",
      ticket: {
        ticket: "c".repeat(43),
        proxyUrl: "https://proxy.example/hermes-proxy",
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
    },
  ])("rejects $name before creating a socket", async ({ ticket }) => {
    const socketFactory = vi.fn();
    await expect(
      connectDirectHermesGateway({
        issueTicket: async () => ticket,
        socketFactory,
      }),
    ).rejects.toThrow(/invalid Hermes proxy/);
    expect(socketFactory).not.toHaveBeenCalled();
  });

  test("does not create a socket when permission-ticket issuance fails", async () => {
    const socketFactory = vi.fn();

    await expect(
      connectDirectHermesGateway({
        issueTicket: async () => {
          throw new Error("Forbidden");
        },
        socketFactory,
      }),
    ).rejects.toThrow("Forbidden");
    expect(socketFactory).not.toHaveBeenCalled();
  });
});
