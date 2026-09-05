import type { DirectHermesGatewayConnectionOptions } from "./direct-hermes-gateway";
import type { GatewayEvent } from "./hermes-json-rpc-gateway";

// Only the remote WebSocket boundary is simulated. Production ticket validation,
// request correlation, event subscriptions and the chat controller all run.
export class DirectHermesTestSocket extends EventTarget {
  readyState: number = WebSocket.CONNECTING;
  autoReady = true;
  calls: { id: string; method: string; params: Record<string, unknown> }[] = [];
  handle: (method: string, params: Record<string, unknown>) => unknown | Promise<unknown> = (method) => {
    if (method === "session.list") return { sessions: [{ id: "saved-a", title: "Saved A" }, { id: "saved-b", title: "Saved B" }] };
    if (method === "session.create") return { session_id: "runtime-1", stored_session_id: "stored-1", messages: [] };
    if (method === "session.resume") return { session_id: "runtime-a", stored_session_id: "saved-a", running: false, messages: [] };
    if (method === "prompt.submit") return { status: "streaming" };
    return {};
  };
  open() { this.readyState = WebSocket.OPEN; this.dispatchEvent(new Event("open")); if (this.autoReady) this.event("gateway.ready", {}, ""); }
  close() { this.readyState = WebSocket.CLOSED; this.dispatchEvent(new Event("close")); }
  send(raw: string) {
    const call = JSON.parse(raw);
    this.calls.push(call);
    Promise.resolve().then(() => this.handle(call.method, call.params)).then(
      result => this.frame({ jsonrpc: "2.0", id: call.id, result }),
      error => this.frame({ jsonrpc: "2.0", id: call.id, error: { code: 4009, message: error.message } }),
    );
  }
  frame(frame: unknown) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(frame) })); }
  event(type: string, payload: unknown, session_id = "runtime-1") { this.frame({ jsonrpc: "2.0", method: "event", params: { type, payload, session_id } satisfies GatewayEvent }); }
}
export function testConnection(socket: DirectHermesTestSocket): DirectHermesGatewayConnectionOptions {
  return {
    issueTicket: async () => ({ ticket: "A".repeat(43), expiresAt: new Date(Date.now() + 30_000), proxyUrl: "wss://test.invalid/hermes-proxy" }),
    socketFactory: () => { queueMicrotask(() => socket.open()); return socket as unknown as WebSocket; },
  };
}
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
