import { afterEach, describe, expect, it, vi } from "vitest";

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readonly url: string;
  readyState = FakeWebSocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  send = vi.fn();

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
  }

  emitOpen() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.(new Event("open"));
  }

  emitMessage(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent);
  }

  emitClose() {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.(new CloseEvent("close"));
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  FakeWebSocket.instances = [];
});

describe("websocket replacement ownership", () => {
  it("ignores late messages and close events from a replaced socket", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);

    const { wsEvents } = await import("../lib/ws-events");
    const { usePresenceStore } = await import("./presence");
    const { useWebSocketStore } = await import("./websocket");
    const snapshots: string[][] = [];
    const onSnapshot = (event: { userIds: string[] }) => snapshots.push(event.userIds);
    wsEvents.on("ws:presence_snapshot", onSnapshot);

    useWebSocketStore.getState().connect("old-token");
    const oldSocket = FakeWebSocket.instances[0]!;
    oldSocket.emitOpen();

    useWebSocketStore.getState().connect("new-token");
    const newSocket = FakeWebSocket.instances[1]!;
    newSocket.emitOpen();
    newSocket.emitMessage({ type: "auth_ok", userId: "user-1" });
    expect(useWebSocketStore.getState().connected).toBe(true);

    oldSocket.emitMessage({ type: "presence_snapshot", userIds: ["stale"] });
    oldSocket.emitClose();
    expect(snapshots).toEqual([]);
    expect(useWebSocketStore.getState().connected).toBe(true);

    newSocket.emitMessage({ type: "presence_snapshot", userIds: ["fresh"] });
    expect(snapshots).toEqual([["fresh"]]);

    usePresenceStore.getState().replaceOnlineUsers(["fresh"]);
    newSocket.emitClose();
    expect(useWebSocketStore.getState().connected).toBe(false);
    expect([...usePresenceStore.getState().onlineUserIds]).toEqual([]);

    wsEvents.off("ws:presence_snapshot", onSnapshot);
    useWebSocketStore.getState().disconnect();
  });
});
