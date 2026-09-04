import {
  assertHermesGatewayEndpointAllowed,
  authenticatedHermesGatewayUrl,
  type HermesGatewayEndpointPolicy,
} from "./endpoint";
import {
  HERMES_PROXY_PROTOCOL,
  hermesProxyTicketFromProtocols,
} from "./protocol";
import { decryptSecret } from "./secrets";
import {
  getHermesProxyTicketStore,
  type HermesProxyGrant,
  type HermesProxyTicketStore,
} from "./tickets";

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_CONNECTION_DURATION_MS = 60 * 60 * 1_000;
const DEFAULT_MAX_CONNECTIONS = 256;
const DEFAULT_MAX_CONNECTIONS_PER_USER = 4;
const DEFAULT_MAX_CONNECTIONS_PER_BOT = 8;
const DEFAULT_MAX_BACKPRESSURE_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_QUEUED_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;
const OPEN = 1;

type BufferedFrame = string | Uint8Array;

interface ProxySocketData {
  connectTimer: ReturnType<typeof setTimeout> | null;
  counted: boolean;
  grant: HermesProxyGrant;
  lifetimeTimer: ReturnType<typeof setTimeout> | null;
  queuedBytes: number;
  queue: BufferedFrame[];
  upstream: WebSocket | null;
}

export interface HermesProxyServerOptions {
  connectTimeoutMs?: number;
  endpointPolicy?: HermesGatewayEndpointPolicy;
  hostname?: string;
  maxBackpressureBytes?: number;
  maxConnectionDurationMs?: number;
  maxConnections?: number;
  maxConnectionsPerBot?: number;
  maxConnectionsPerUser?: number;
  maxPayloadBytes?: number;
  maxQueuedBytes?: number;
  port?: number;
  ticketStore?: HermesProxyTicketStore;
}

function frameBytes(frame: BufferedFrame): number {
  return typeof frame === "string"
    ? Buffer.byteLength(frame, "utf8")
    : frame.byteLength;
}

function copyFrame(frame: string | Buffer): BufferedFrame {
  return typeof frame === "string" ? frame : Uint8Array.from(frame);
}

function clearConnectTimer(data: ProxySocketData): void {
  if (data.connectTimer) {
    clearTimeout(data.connectTimer);
    data.connectTimer = null;
  }
}

function clearLifetimeTimer(data: ProxySocketData): void {
  if (data.lifetimeTimer) {
    clearTimeout(data.lifetimeTimer);
    data.lifetimeTimer = null;
  }
}

function closeUpstream(data: ProxySocketData): void {
  clearConnectTimer(data);
  clearLifetimeTimer(data);
  const upstream = data.upstream;
  data.upstream = null;
  data.queue = [];
  data.queuedBytes = 0;
  if (upstream && upstream.readyState < WebSocket.CLOSING) {
    try {
      upstream.close();
    } catch {
      // The connection is already unusable.
    }
  }
}

function closeDownstream(
  socket: Bun.ServerWebSocket<ProxySocketData>,
  code: number,
  reason: string,
): void {
  if (socket.readyState === OPEN) {
    socket.close(code, reason);
  }
}

function forwardUpstreamFrame(
  socket: Bun.ServerWebSocket<ProxySocketData>,
  value: unknown,
): void {
  if (socket.readyState !== OPEN) return;
  if (typeof value === "string") {
    socket.send(value);
    return;
  }
  if (value instanceof ArrayBuffer) {
    socket.send(new Uint8Array(value));
    return;
  }
  if (ArrayBuffer.isView(value)) {
    socket.send(
      new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
    );
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

export function createHermesProxyServer(
  options: HermesProxyServerOptions = {},
) {
  const ticketStore = options.ticketStore ?? getHermesProxyTicketStore();
  const connectTimeoutMs = options.connectTimeoutMs ??
    DEFAULT_CONNECT_TIMEOUT_MS;
  const maxConnectionDurationMs = options.maxConnectionDurationMs ??
    DEFAULT_MAX_CONNECTION_DURATION_MS;
  const maxBackpressureBytes = positiveInteger(
    options.maxBackpressureBytes ?? DEFAULT_MAX_BACKPRESSURE_BYTES,
    "maxBackpressureBytes",
  );
  const maxConnections = positiveInteger(
    options.maxConnections ?? DEFAULT_MAX_CONNECTIONS,
    "maxConnections",
  );
  const maxConnectionsPerBot = positiveInteger(
    options.maxConnectionsPerBot ?? DEFAULT_MAX_CONNECTIONS_PER_BOT,
    "maxConnectionsPerBot",
  );
  const maxConnectionsPerUser = positiveInteger(
    options.maxConnectionsPerUser ?? DEFAULT_MAX_CONNECTIONS_PER_USER,
    "maxConnectionsPerUser",
  );
  const maxQueuedBytes = options.maxQueuedBytes ?? DEFAULT_MAX_QUEUED_BYTES;
  let activeConnections = 0;
  const activeByBot = new Map<string, number>();
  const activeByUser = new Map<string, number>();

  const atConnectionLimit = (grant: HermesProxyGrant): boolean =>
    activeConnections >= maxConnections ||
    (activeByBot.get(grant.botId) ?? 0) >= maxConnectionsPerBot ||
    (activeByUser.get(grant.userId) ?? 0) >= maxConnectionsPerUser;

  const acquireConnection = (grant: HermesProxyGrant): void => {
    activeConnections += 1;
    activeByBot.set(grant.botId, (activeByBot.get(grant.botId) ?? 0) + 1);
    activeByUser.set(grant.userId, (activeByUser.get(grant.userId) ?? 0) + 1);
  };

  const releaseConnection = (data: ProxySocketData): void => {
    if (!data.counted) return;
    data.counted = false;
    activeConnections -= 1;
    for (const [map, key] of [
      [activeByBot, data.grant.botId],
      [activeByUser, data.grant.userId],
    ] as const) {
      const remaining = (map.get(key) ?? 1) - 1;
      if (remaining > 0) map.set(key, remaining);
      else map.delete(key);
    }
  };

  return Bun.serve<ProxySocketData>({
    hostname: options.hostname ?? "127.0.0.1",
    port: options.port ?? 3001,
    fetch: async (request, server) => {
      const url = new URL(request.url);
      if (url.pathname === "/health") {
        return Response.json({ status: "ok", service: "hermes-proxy" });
      }
      if (url.pathname !== "/hermes-proxy") {
        return new Response("Not found", { status: 404 });
      }

      const ticket = hermesProxyTicketFromProtocols(
        request.headers.get("sec-websocket-protocol"),
      );
      if (!ticket) {
        return new Response("Unauthorized", { status: 401 });
      }

      let grant: HermesProxyGrant | null;
      try {
        grant = await ticketStore.consume(ticket);
      } catch {
        return new Response("Proxy ticket service unavailable", { status: 503 });
      }
      if (!grant) {
        return new Response("Unauthorized", { status: 401 });
      }
      if (atConnectionLimit(grant)) {
        return new Response("Hermes proxy connection limit reached", {
          status: 429,
        });
      }

      acquireConnection(grant);
      const data: ProxySocketData = {
        connectTimer: null,
        counted: true,
        grant,
        lifetimeTimer: null,
        queuedBytes: 0,
        queue: [],
        upstream: null,
      };
      const upgraded = server.upgrade(request, {
        data,
        headers: {
          "Sec-WebSocket-Protocol": HERMES_PROXY_PROTOCOL,
        },
      });
      if (upgraded) return;
      releaseConnection(data);
      return new Response("WebSocket upgrade failed", { status: 400 });
    },
    websocket: {
      backpressureLimit: maxBackpressureBytes,
      closeOnBackpressureLimit: true,
      idleTimeout: 120,
      maxPayloadLength: options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES,
      open(socket) {
        const data = socket.data;
        let upstreamUrl: string;
        try {
          const endpoint = assertHermesGatewayEndpointAllowed(
            data.grant.endpoint,
            options.endpointPolicy,
          );
          const gatewayToken = decryptSecret(
            data.grant.gatewayTokenEncrypted,
          );
          upstreamUrl = authenticatedHermesGatewayUrl(
            endpoint,
            gatewayToken,
          );
        } catch {
          closeDownstream(socket, 1011, "Hermes gateway unavailable");
          return;
        }

        let upstream: WebSocket;
        try {
          upstream = new WebSocket(upstreamUrl);
          upstream.binaryType = "arraybuffer";
          data.upstream = upstream;
        } catch {
          closeDownstream(socket, 1011, "Hermes gateway unavailable");
          return;
        }

        data.connectTimer = setTimeout(() => {
          if (data.upstream === upstream && upstream.readyState !== OPEN) {
            closeUpstream(data);
            closeDownstream(socket, 1011, "Hermes gateway unavailable");
          }
        }, connectTimeoutMs);
        if (maxConnectionDurationMs > 0) {
          data.lifetimeTimer = setTimeout(() => {
            closeUpstream(data);
            closeDownstream(
              socket,
              1008,
              "Hermes proxy authorization expired",
            );
          }, maxConnectionDurationMs);
        }

        upstream.addEventListener("open", () => {
          if (data.upstream !== upstream || socket.readyState !== OPEN) return;
          clearConnectTimer(data);
          const queued = data.queue;
          data.queue = [];
          data.queuedBytes = 0;
          try {
            for (const frame of queued) upstream.send(frame);
          } catch {
            closeUpstream(data);
            closeDownstream(socket, 1011, "Hermes gateway unavailable");
          }
        });
        upstream.addEventListener("message", (event) => {
          if (data.upstream === upstream) {
            forwardUpstreamFrame(socket, event.data);
          }
        });
        upstream.addEventListener("error", () => {
          if (data.upstream !== upstream) return;
          closeUpstream(data);
          closeDownstream(socket, 1011, "Hermes gateway unavailable");
        });
        upstream.addEventListener("close", () => {
          if (data.upstream !== upstream) return;
          closeUpstream(data);
          closeDownstream(socket, 1011, "Hermes gateway closed");
        });
      },
      message(socket, rawFrame) {
        const data = socket.data;
        const frame = copyFrame(rawFrame);
        const upstream = data.upstream;
        if (!upstream) {
          closeDownstream(socket, 1011, "Hermes gateway unavailable");
          return;
        }
        if (upstream.readyState === OPEN) {
          try {
            upstream.send(frame);
          } catch {
            closeUpstream(data);
            closeDownstream(socket, 1011, "Hermes gateway unavailable");
          }
          return;
        }
        const bytes = frameBytes(frame);
        if (data.queuedBytes + bytes > maxQueuedBytes) {
          closeUpstream(data);
          closeDownstream(socket, 1009, "Hermes gateway queue limit exceeded");
          return;
        }
        data.queue.push(frame);
        data.queuedBytes += bytes;
      },
      close(socket) {
        closeUpstream(socket.data);
        releaseConnection(socket.data);
      },
    },
  });
}

function portFromEnv(): number {
  const value = Number(process.env.THECHAT_HERMES_PROXY_PORT ?? 3001);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error("THECHAT_HERMES_PROXY_PORT must be a valid TCP port");
  }
  return value;
}

if (import.meta.main) {
  const ticketStore = getHermesProxyTicketStore();
  const server = createHermesProxyServer({
    hostname: process.env.THECHAT_HERMES_PROXY_HOST?.trim() || "127.0.0.1",
    port: portFromEnv(),
    ticketStore,
  });
  console.log(
    `Hermes proxy listening on ${server.hostname}:${server.port}`,
  );

  const shutdown = async () => {
    server.stop(true);
    await ticketStore.close?.();
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());
}
