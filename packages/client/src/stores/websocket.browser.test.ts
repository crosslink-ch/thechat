import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("../platform/environment", () => ({ isWeb: true }));
import { useWebSocketStore } from "./websocket";
import { useAuthStore } from "./auth";
import { queryClient } from "../lib/query-client";
import { resetPrivateSession } from "../lib/session-boundary";
it("does not accumulate session-reset listeners across heartbeats", () => {
  useWebSocketStore.getState().connect(null);
  const socket = Socket.instances[0]; socket.open(); socket.receive({ type: "auth_ok", userId: "alice" });
  for (let i = 0; i < 4; i++) {
    vi.advanceTimersByTime(30_000);
    socket.receive({ type: "pong" });
  }
  const disconnect = vi.spyOn(useWebSocketStore.getState(), "disconnect");
  resetPrivateSession();
  expect(disconnect).toHaveBeenCalledTimes(1);
  disconnect.mockRestore();
});
it("expires identity, private state and the authorized socket on terminal auth failure", () => {
  useAuthStore.setState({ user: { id: "alice" } as never, token: null });
  queryClient.setQueryData(["private"], "secret");
  useWebSocketStore.getState().connect(null);
  const socket = Socket.instances[0]; socket.open(); socket.receive({ type: "auth_ok", userId: "alice" });
  socket.receive({ type: "auth_error", retryable: false });
  expect(useAuthStore.getState().user).toBeNull();
  expect(queryClient.getQueryData(["private"])).toBeUndefined();
  expect(useWebSocketStore.getState().connected).toBe(false);
});
it("never flushes the previous account's messages if cookie identity changed while suspended", () => {
  useAuthStore.setState({ user: { id: "alice" } as never, token: null });
  const initialize = vi.spyOn(useAuthStore.getState(), "initialize").mockResolvedValue();
  useWebSocketStore.getState().connect(null);
  const socket = Socket.instances[0]; socket.open();
  useWebSocketStore.getState().sendMessage("alice-private", "secret");
  socket.receive({ type: "auth_ok", userId: "bob" });
  expect(socket.sent).toEqual([{ type: "auth", mode: "cookie" }]);
  expect(useAuthStore.getState().user).toBeNull();
  expect(initialize).toHaveBeenCalled();
  initialize.mockRestore();
});
class Socket {
  static OPEN = 1; static CLOSED = 3; static instances: Socket[] = [];
  readyState = 0; sent: unknown[] = [];
  onopen: (() => void) | null = null; onclose: (() => void) | null = null;
  onerror: (() => void) | null = null; onmessage: ((e: { data: string }) => void) | null = null;
  constructor(readonly url: string) { Socket.instances.push(this); }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  open() { this.readyState = 1; this.onopen?.(); }
  receive(data: unknown) { this.onmessage?.({ data: JSON.stringify(data) }); }
  close() { this.readyState = 3; this.onclose?.(); }
}
beforeEach(() => { useAuthStore.setState({ user: { id: "alice" } as never, token: null }); vi.useFakeTimers(); vi.stubGlobal("WebSocket", Socket); Socket.instances = []; useWebSocketStore.getState().disconnect(); });
afterEach(() => { useWebSocketStore.getState().disconnect(); vi.useRealTimers(); vi.unstubAllGlobals(); });
it("authenticates via cookies and queues all application sends until auth_ok", () => {
  useWebSocketStore.getState().connect(null);
  const socket = Socket.instances[0];
  expect(socket).toBeDefined();
  socket.open();
  useWebSocketStore.getState().sendMessage("chat", "private");
  useWebSocketStore.getState().sendTyping("chat");
  expect(socket.sent).toEqual([{ type: "auth", mode: "cookie" }]);
  socket.receive({ type: "auth_ok", userId: "alice" });
  expect(socket.sent).toHaveLength(2);
  expect(socket.sent[1]).toMatchObject({ type: "send_message", content: "private" });
});
it("retries transient authentication but discards pending sends after an authoritative rejection", () => {
  useWebSocketStore.getState().connect(null);
  const socket = Socket.instances[0];
  expect(socket).toBeDefined();
  socket.open();
  useWebSocketStore.getState().sendMessage("chat", "private");
  socket.receive({ type: "auth_error", retryable: true });
  vi.advanceTimersByTime(1000);
  expect(Socket.instances).toHaveLength(2);
  const retry = Socket.instances[1]; retry.open();
  retry.receive({ type: "auth_error", retryable: false });
  vi.advanceTimersByTime(60_000);
  expect(Socket.instances).toHaveLength(2);
  expect(useWebSocketStore.getState()).toMatchObject({ connected: false, reconnecting: false });
  useAuthStore.setState({ user: { id: "alice" } as never, token: null });
  useWebSocketStore.getState().connect(null);
  const fresh = Socket.instances[2]; fresh.open(); fresh.receive({ type: "auth_ok", userId: "alice" });
  expect(fresh.sent).toEqual([{ type: "auth", mode: "cookie" }]);
});
