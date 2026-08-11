const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export interface HermesRpcEvent<P = Record<string, unknown>> {
  type: string;
  session_id?: string;
  payload?: P;
}

export interface HermesRpcErrorShape {
  code?: number;
  message?: string;
  data?: unknown;
}

export interface HermesRpcFrame {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: HermesRpcEvent;
  result?: unknown;
  error?: HermesRpcErrorShape;
}

export interface HermesRpcSessionListItem {
  id: string;
  title: string;
  preview: string;
  started_at: number;
  message_count: number;
  source: string;
}

export interface HermesRpcSessionListResult {
  sessions: HermesRpcSessionListItem[];
}

export interface HermesRpcSessionCreateResult {
  session_id: string;
  stored_session_id: string;
  message_count: number;
  messages: unknown[];
  info?: Record<string, unknown>;
}

export interface HermesRpcSessionResumeResult {
  session_id: string;
  session_key?: string;
  resumed?: string;
  running?: boolean;
  status?: string;
  messages?: unknown[];
}

type EventHandler = (event: HermesRpcEvent) => void;
type SocketEventHandler = (event: any) => void;

export interface HermesRpcWebSocketLike {
  readonly readyState: number;
  addEventListener(type: string, handler: SocketEventHandler, options?: { once?: boolean }): void;
  removeEventListener(type: string, handler: SocketEventHandler): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface HermesRpcClientOptions {
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
  socketFactory?: (url: string) => HermesRpcWebSocketLike;
}

type PendingRequest = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
  detachAbort?: () => void;
};

export class HermesRpcError extends Error {
  readonly code?: number;

  constructor(message: string, code?: number) {
    super(message);
    this.name = "HermesRpcError";
    this.code = code;
  }
}

/**
 * Accept a dashboard base URL or WebSocket endpoint and return the canonical
 * upstream JSON-RPC endpoint. Query strings, credentials, and fragments are
 * rejected so authentication can only enter through the separately encrypted
 * gateway-token field.
 */
export function normalizeHermesRpcEndpoint(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Hermes RPC endpoint is required");
  if (/\s/.test(trimmed)) throw new Error("Hermes RPC endpoint cannot contain whitespace");

  const withScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `http://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error("Hermes RPC endpoint must be a valid host or URL");
  }

  if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) {
    throw new Error("Hermes RPC endpoint must use http, https, ws, or wss");
  }
  if (!url.hostname) throw new Error("Hermes RPC endpoint must include a host");
  if (url.username || url.password) {
    throw new Error("Hermes RPC endpoint must not contain embedded credentials");
  }
  if (url.search || url.hash) {
    throw new Error("Hermes RPC endpoint must not contain a query string or fragment");
  }

  url.protocol = url.protocol === "https:" || url.protocol === "wss:" ? "wss:" : "ws:";
  const basePath = url.pathname.replace(/\/+$/, "");
  if (basePath.includes("/api/ws") && !basePath.endsWith("/api/ws")) {
    throw new Error("Hermes RPC endpoint path must end with /api/ws");
  }
  url.pathname = basePath.endsWith("/api/ws")
    ? basePath || "/api/ws"
    : `${basePath}/api/ws`.replace(/^\/\//, "/");
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function hermesRpcAuthenticatedUrl(endpoint: string, gatewayToken?: string | null): string {
  const url = new URL(normalizeHermesRpcEndpoint(endpoint));
  if (gatewayToken) url.searchParams.set("token", gatewayToken);
  return url.toString();
}

/** Remove gateway credentials and common secret-bearing URL values from errors. */
export function redactHermesRpcText(value: unknown, gatewayToken?: string | null): string {
  let text = value instanceof Error ? value.message : String(value ?? "Unknown Hermes RPC error");
  if (gatewayToken) text = text.split(gatewayToken).join("[redacted]");
  text = text.replace(/([?&](?:token|ticket|internal)=)[^&#\s]+/gi, "$1[redacted]");
  text = text.replace(/(authorization:\s*bearer\s+)[^\s]+/gi, "$1[redacted]");
  return text;
}

export class HermesRpcClient {
  private readonly endpoint: string;
  private readonly gatewayToken: string | null;
  private readonly connectTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly socketFactory: (url: string) => HermesRpcWebSocketLike;
  private readonly requestPrefix = crypto.randomUUID();
  private readonly pending = new Map<string | number, PendingRequest>();
  private readonly eventHandlers = new Map<string, Set<EventHandler>>();
  private readonly anyEventHandlers = new Set<EventHandler>();
  private readonly disconnectHandlers = new Set<(error: Error) => void>();
  private socket: HermesRpcWebSocketLike | null = null;
  private socketCleanup: (() => void) | null = null;
  private cancelConnect: ((error: Error) => void) | null = null;
  private nextRequestId = 0;

  constructor(endpoint: string, gatewayToken?: string | null, options: HermesRpcClientOptions = {}) {
    this.endpoint = normalizeHermesRpcEndpoint(endpoint);
    this.gatewayToken = gatewayToken?.trim() || null;
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.socketFactory = options.socketFactory ?? ((url) => new WebSocket(url));
  }

  get connected(): boolean {
    return this.socket?.readyState === 1;
  }

  on(type: string, handler: EventHandler): () => void {
    const handlers = this.eventHandlers.get(type) ?? new Set<EventHandler>();
    handlers.add(handler);
    this.eventHandlers.set(type, handlers);
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) this.eventHandlers.delete(type);
    };
  }

  onEvent(handler: EventHandler): () => void {
    this.anyEventHandlers.add(handler);
    return () => this.anyEventHandlers.delete(handler);
  }

  onDisconnect(handler: (error: Error) => void): () => void {
    this.disconnectHandlers.add(handler);
    return () => this.disconnectHandlers.delete(handler);
  }

  async connect(signal?: AbortSignal): Promise<void> {
    if (this.connected) return;
    if (signal?.aborted) throw abortError();

    const socketUrl = hermesRpcAuthenticatedUrl(this.endpoint, this.gatewayToken);
    let socket: HermesRpcWebSocketLike;
    try {
      socket = this.socketFactory(socketUrl);
    } catch (error) {
      throw new HermesRpcError(redactHermesRpcText(error, this.gatewayToken));
    }
    this.socket = socket;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let cancelCurrent!: (error: Error) => void;

      const cleanupHandshake = () => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("close", onHandshakeClose);
        socket.removeEventListener("error", onHandshakeError);
        if (this.cancelConnect === cancelCurrent) this.cancelConnect = null;
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanupHandshake();
        this.disposeSocket(socket, error);
        reject(error);
      };
      const onAbort = () => fail(abortError());
      const onHandshakeClose = () =>
        fail(new HermesRpcError("Hermes RPC connection closed during handshake"));
      const onHandshakeError = () =>
        fail(new HermesRpcError("Could not connect to the Hermes RPC gateway"));
      const onOpen = () => {
        if (settled || this.socket !== socket) return;
        settled = true;
        cleanupHandshake();
        this.installSocketListeners(socket);
        resolve();
      };
      cancelCurrent = fail;
      this.cancelConnect = cancelCurrent;

      socket.addEventListener("open", onOpen);
      socket.addEventListener("close", onHandshakeClose);
      socket.addEventListener("error", onHandshakeError);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (this.connectTimeoutMs > 0) {
        timer = setTimeout(
          () => fail(new HermesRpcError("Timed out connecting to the Hermes RPC gateway")),
          this.connectTimeoutMs,
        );
      }
    });
  }

  request<T>(
    method: string,
    params: Record<string, unknown> = {},
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<T> {
    const socket = this.socket;
    if (!socket || socket.readyState !== 1) {
      return Promise.reject(new HermesRpcError("Hermes RPC gateway is not connected"));
    }
    if (options.signal?.aborted) return Promise.reject(abortError());

    const id = `${this.requestPrefix}:${++this.nextRequestId}`;
    return new Promise<T>((resolve, reject) => {
      const pending: PendingRequest = {
        method,
        resolve: (value) => resolve(value as T),
        reject,
      };
      const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs;
      if (timeoutMs > 0) {
        pending.timer = setTimeout(() => {
          if (!this.pending.delete(id)) return;
          pending.detachAbort?.();
          reject(new HermesRpcError(`Hermes RPC request timed out: ${method}`));
        }, timeoutMs);
      }
      if (options.signal) {
        const onAbort = () => {
          if (!this.pending.delete(id)) return;
          if (pending.timer) clearTimeout(pending.timer);
          options.signal?.removeEventListener("abort", onAbort);
          reject(abortError());
        };
        pending.detachAbort = () => options.signal?.removeEventListener("abort", onAbort);
        options.signal.addEventListener("abort", onAbort, { once: true });
      }
      this.pending.set(id, pending);

      try {
        socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      } catch (error) {
        this.rejectPending(id, new HermesRpcError(redactHermesRpcText(error, this.gatewayToken)));
      }
    });
  }

  sessionList(limit = 200, signal?: AbortSignal): Promise<HermesRpcSessionListResult> {
    return this.request("session.list", { limit }, { signal });
  }

  sessionCreate(signal?: AbortSignal): Promise<HermesRpcSessionCreateResult> {
    return this.request(
      "session.create",
      { source: "thechat", close_on_disconnect: true },
      { signal },
    );
  }

  sessionResume(storedSessionId: string, signal?: AbortSignal): Promise<HermesRpcSessionResumeResult> {
    return this.request(
      "session.resume",
      {
        session_id: storedSessionId,
        omit_messages: true,
        close_on_disconnect: true,
      },
      { signal },
    );
  }

  sessionHistory(runtimeSessionId: string, signal?: AbortSignal): Promise<{ count: number; messages: unknown[] }> {
    return this.request("session.history", { session_id: runtimeSessionId }, { signal });
  }

  submitPrompt(runtimeSessionId: string, text: string, signal?: AbortSignal): Promise<{ status: string }> {
    return this.request("prompt.submit", { session_id: runtimeSessionId, text }, { signal });
  }

  interrupt(runtimeSessionId: string, signal?: AbortSignal): Promise<{ status: string }> {
    return this.request("session.interrupt", { session_id: runtimeSessionId }, { signal });
  }

  close(): void {
    const socket = this.socket;
    if (!socket) return;
    const error = new HermesRpcError("Hermes RPC connection closed");
    this.cancelConnect?.(error);
    this.disposeSocket(socket, error);
    try {
      socket.close(1000, "client closed");
    } catch {
      // Socket cleanup above is authoritative.
    }
  }

  private installSocketListeners(socket: HermesRpcWebSocketLike) {
    const onMessage = (event: any) => void this.handleRawMessage(event?.data);
    const onClose = () =>
      this.disposeSocket(socket, new HermesRpcError("Hermes RPC connection closed unexpectedly"));
    const onError = () =>
      this.disposeSocket(socket, new HermesRpcError("Hermes RPC connection failed"));
    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", onClose);
    socket.addEventListener("error", onError);
    this.socketCleanup = () => {
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("close", onClose);
      socket.removeEventListener("error", onError);
    };
  }

  private async handleRawMessage(raw: unknown) {
    let text: string;
    if (typeof raw === "string") text = raw;
    else if (raw instanceof ArrayBuffer) text = new TextDecoder().decode(raw);
    else if (typeof Blob !== "undefined" && raw instanceof Blob) text = await raw.text();
    else text = String(raw);

    let frame: HermesRpcFrame;
    try {
      frame = JSON.parse(text) as HermesRpcFrame;
    } catch {
      return;
    }

    if (frame.method === "event" && frame.params && typeof frame.params.type === "string") {
      const event = frame.params;
      for (const handler of this.eventHandlers.get(event.type) ?? []) handler(event);
      for (const handler of this.anyEventHandlers) handler(event);
      return;
    }

    if (frame.id === undefined || frame.id === null) return;
    const pending = this.pending.get(frame.id);
    if (!pending) return;
    this.pending.delete(frame.id);
    if (pending.timer) clearTimeout(pending.timer);
    pending.detachAbort?.();

    if (frame.error) {
      pending.reject(
        new HermesRpcError(
          redactHermesRpcText(
            frame.error.message || `Hermes RPC request failed: ${pending.method}`,
            this.gatewayToken,
          ),
          frame.error.code,
        ),
      );
    } else {
      pending.resolve(frame.result);
    }
  }

  private rejectPending(id: string | number, error: Error) {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    if (pending.timer) clearTimeout(pending.timer);
    pending.detachAbort?.();
    pending.reject(error);
  }

  private rejectAllPending(error: Error) {
    for (const id of [...this.pending.keys()]) this.rejectPending(id, error);
  }

  private disposeSocket(socket: HermesRpcWebSocketLike, error: Error) {
    if (this.socket !== socket) return;
    this.socketCleanup?.();
    this.socketCleanup = null;
    this.socket = null;
    this.rejectAllPending(error);
    for (const handler of this.disconnectHandlers) handler(error);
  }
}

function abortError(): Error {
  const error = new Error("Hermes RPC operation was cancelled");
  error.name = "AbortError";
  return error;
}
