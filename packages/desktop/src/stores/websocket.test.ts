import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  WEBSOCKET_BOUNDARY_EVENT,
  useWebSocketStore,
} from "./websocket";

type BoundaryDetail = {
  operation: string;
  pendingMessageCount: number;
  pendingEventTypes?: string[];
};

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readonly CONNECTING = FakeWebSocket.CONNECTING;
  readonly OPEN = FakeWebSocket.OPEN;
  readonly CLOSED = FakeWebSocket.CLOSED;
  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(_url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
  }

  authenticate() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
    this.onmessage?.(
      new MessageEvent("message", {
        data: JSON.stringify({ type: "auth_ok" }),
      }),
    );
  }
}

describe("WebSocket application send boundary", () => {
  const originalWebSocket = globalThis.WebSocket;
  const records: BoundaryDetail[] = [];
  const record = (event: Event) => {
    records.push((event as CustomEvent<BoundaryDetail>).detail);
  };

  beforeEach(() => {
    records.length = 0;
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
    window.addEventListener(WEBSOCKET_BOUNDARY_EVENT, record);
    useWebSocketStore.getState().disconnect();
  });

  afterEach(() => {
    useWebSocketStore.getState().disconnect();
    window.removeEventListener(WEBSOCKET_BOUNDARY_EVENT, record);
    vi.stubGlobal("WebSocket", originalWebSocket);
  });

  it("records the app-level request and offline queue before native transport", () => {
    useWebSocketStore.getState().sendMessage("conversation-1", "hello", "thread-1");

    expect(records).toEqual([
      expect.objectContaining({
        operation: "send_message_requested",
        pendingMessageCount: 0,
      }),
      expect.objectContaining({
        operation: "message_queued",
        pendingMessageCount: 1,
      }),
    ]);
  });

  it("exposes exactly what a controlled reconnect flushes", () => {
    useWebSocketStore.getState().connect("token");
    useWebSocketStore.getState().sendMessage("conversation-1", "hello", null);
    const socket = FakeWebSocket.instances.at(-1);
    if (!socket) throw new Error("Expected a WebSocket instance");

    socket.authenticate();

    expect(records).toContainEqual(
      expect.objectContaining({
        operation: "pending_flush_started",
        pendingMessageCount: 1,
        pendingEventTypes: ["send_message"],
      }),
    );
    expect(records).toContainEqual(
      expect.objectContaining({
        operation: "message_transported",
        pendingMessageCount: 0,
      }),
    );
    expect(socket.sent.map((item) => JSON.parse(item).type)).toEqual([
      "auth",
      "send_message",
    ]);
  });
});
