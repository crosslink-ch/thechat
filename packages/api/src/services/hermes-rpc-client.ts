export interface HermesRpcSessionListItem {
  id: string;
  resolved_id?: string;
  title: string;
  preview: string;
  started_at: number;
  message_count: number;
  source: string;
}

interface JsonRpcError {
  code?: number;
  message?: string;
}

interface JsonRpcResponse {
  id?: string;
  result?: { sessions?: unknown };
  error?: JsonRpcError;
}

const CONNECT_TIMEOUT_MS = 10_000;
const SESSION_LIST_LIMIT = 200;

export function normalizeHermesRpcEndpoint(input: string): string {
  const value = input.trim();
  if (!value) throw new Error("Hermes gateway URL is required");

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Hermes gateway URL must be an absolute URL");
  }

  const protocols: Record<string, string> = {
    "http:": "ws:",
    "https:": "wss:",
    "ws:": "ws:",
    "wss:": "wss:",
  };
  const websocketProtocol = protocols[url.protocol];
  if (!websocketProtocol) {
    throw new Error("Hermes gateway URL must use http, https, ws, or wss");
  }
  if (url.username || url.password) {
    throw new Error("Hermes gateway URL must not contain credentials");
  }
  if (url.search) {
    throw new Error("Hermes gateway URL must not contain a query string");
  }
  if (url.hash) {
    throw new Error("Hermes gateway URL must not contain a fragment");
  }

  url.protocol = websocketProtocol;
  const path = url.pathname.replace(/\/+$/, "");
  if (path.includes("/api/ws") && !path.endsWith("/api/ws")) {
    throw new Error("Hermes gateway URL path must end with /api/ws");
  }
  url.pathname = path.endsWith("/api/ws") ? path : `${path}/api/ws`;

  return url.toString().replace(/\/$/, "");
}

export function hermesRpcAuthenticatedUrl(
  endpoint: string,
  gatewayToken: string,
): string {
  const token = gatewayToken.trim();
  if (!token) throw new Error("Hermes gateway token is required");
  const url = new URL(normalizeHermesRpcEndpoint(endpoint));
  url.searchParams.set("token", token);
  return url.toString();
}

export async function listHermesRpcSessions(
  endpoint: string,
  gatewayToken: string,
): Promise<HermesRpcSessionListItem[]> {
  const authenticatedUrl = hermesRpcAuthenticatedUrl(endpoint, gatewayToken);
  const requestId = crypto.randomUUID();

  return new Promise((resolve, reject) => {
    let socket: WebSocket;
    let settled = false;
    let opened = false;

    const timeout = setTimeout(() => {
      fail(new Error(opened
        ? "Hermes session.list request timed out"
        : "Hermes gateway connection timed out"));
    }, CONNECT_TIMEOUT_MS);

    function cleanup() {
      clearTimeout(timeout);
      socket?.removeEventListener("open", handleOpen);
      socket?.removeEventListener("message", handleMessage);
      socket?.removeEventListener("error", handleError);
      socket?.removeEventListener("close", handleClose);
    }

    function finish(sessions: HermesRpcSessionListItem[]) {
      if (settled) return;
      settled = true;
      cleanup();
      socket.close();
      resolve(sessions);
    }

    function fail(error: Error) {
      if (settled) return;
      settled = true;
      cleanup();
      socket?.close();
      reject(error);
    }

    function handleOpen() {
      opened = true;
      socket.send(JSON.stringify({
        jsonrpc: "2.0",
        id: requestId,
        method: "session.list",
        params: { limit: SESSION_LIST_LIMIT },
      }));
    }

    function handleMessage(event: MessageEvent) {
      let frame: JsonRpcResponse;
      try {
        frame = JSON.parse(String(event.data)) as JsonRpcResponse;
      } catch {
        fail(new Error("Hermes gateway returned invalid JSON"));
        return;
      }
      if (frame.id !== requestId) return;
      if (frame.error) {
        const code = typeof frame.error.code === "number"
          ? ` (${frame.error.code})`
          : "";
        const message = redactHermesRpcText(
          frame.error.message || "Unknown JSON-RPC error",
          gatewayToken,
        );
        fail(new Error(`Hermes session.list failed${code}: ${message}`));
        return;
      }
      if (!Array.isArray(frame.result?.sessions)) {
        fail(new Error("Hermes session.list returned an invalid result"));
        return;
      }

      try {
        finish(frame.result.sessions.map(parseSession));
      } catch (error) {
        fail(error instanceof Error ? error : new Error("Invalid Hermes session"));
      }
    }

    function handleError() {
      fail(new Error("Hermes gateway WebSocket failed"));
    }

    function handleClose(event: CloseEvent) {
      const reason = event.reason
        ? `: ${redactHermesRpcText(event.reason, gatewayToken)}`
        : "";
      fail(new Error(`Hermes gateway closed before session.list completed (${event.code})${reason}`));
    }

    try {
      socket = new WebSocket(authenticatedUrl);
      socket.addEventListener("open", handleOpen);
      socket.addEventListener("message", handleMessage);
      socket.addEventListener("error", handleError);
      socket.addEventListener("close", handleClose);
    } catch (error) {
      fail(error instanceof Error ? error : new Error("Could not open Hermes gateway"));
    }
  });
}

export function redactHermesRpcText(value: unknown, gatewayToken: string): string {
  let text = value instanceof Error ? value.message : String(value);
  const token = gatewayToken.trim();
  if (!token) return text;
  for (const candidate of new Set([
    token,
    encodeURIComponent(token),
    new URLSearchParams({ token }).get("token") ?? token,
  ])) {
    text = text.split(candidate).join("[redacted]");
  }
  return text;
}

function parseSession(value: unknown): HermesRpcSessionListItem {
  if (!value || typeof value !== "object") {
    throw new Error("Hermes session.list returned a non-object session");
  }
  const session = value as Record<string, unknown>;
  if (typeof session.id !== "string" || !session.id) {
    throw new Error("Hermes session.list returned a session without an id");
  }
  return {
    id: session.id,
    ...(typeof session.resolved_id === "string"
      ? { resolved_id: session.resolved_id }
      : {}),
    title: typeof session.title === "string" ? session.title : "",
    preview: typeof session.preview === "string" ? session.preview : "",
    started_at: typeof session.started_at === "number" ? session.started_at : 0,
    message_count: typeof session.message_count === "number" ? session.message_count : 0,
    source: typeof session.source === "string" ? session.source : "",
  };
}
