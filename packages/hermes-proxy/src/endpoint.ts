export function normalizeHermesGatewayEndpoint(input: string): string {
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

export interface HermesGatewayEndpointPolicy {
  allowedOrigins?: readonly string[];
  allowLoopback?: boolean;
}

function normalizeAllowedOrigin(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error(
      "THECHAT_HERMES_PROXY_ALLOWED_ORIGINS must contain absolute origins",
    );
  }

  const protocols: Record<string, string> = {
    "http:": "ws:",
    "https:": "wss:",
    "ws:": "ws:",
    "wss:": "wss:",
  };
  const websocketProtocol = protocols[url.protocol];
  if (
    !websocketProtocol ||
    url.username ||
    url.password ||
    (url.pathname !== "" && url.pathname !== "/") ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "THECHAT_HERMES_PROXY_ALLOWED_ORIGINS must contain only http, https, ws, or wss origins",
    );
  }

  url.protocol = websocketProtocol;
  return url.origin;
}

export function hermesGatewayEndpointPolicyFromEnv(
  env: Record<string, string | undefined> = process.env,
): Required<HermesGatewayEndpointPolicy> {
  const allowedOrigins = (env.THECHAT_HERMES_PROXY_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  return {
    allowedOrigins,
    allowLoopback: env.THECHAT_HERMES_PROXY_ALLOW_LOOPBACK === "true",
  };
}

function isLoopbackHostname(hostname: string): boolean {
  const value = hostname.toLowerCase();
  return value === "localhost" || value === "127.0.0.1" || value === "[::1]";
}

export function assertHermesGatewayEndpointAllowed(
  endpoint: string,
  policy?: HermesGatewayEndpointPolicy,
): string {
  const normalizedEndpoint = normalizeHermesGatewayEndpoint(endpoint);
  const endpointUrl = new URL(normalizedEndpoint);
  const defaults = hermesGatewayEndpointPolicyFromEnv();
  const allowedOrigins = new Set(
    [...(policy?.allowedOrigins ?? defaults.allowedOrigins)].map(
      normalizeAllowedOrigin,
    ),
  );
  const allowLoopback = policy?.allowLoopback ?? defaults.allowLoopback;

  if (
    allowedOrigins.has(endpointUrl.origin) ||
    (allowLoopback && isLoopbackHostname(endpointUrl.hostname))
  ) {
    return normalizedEndpoint;
  }

  throw new Error("Hermes gateway origin is not allowed by proxy policy");
}

export function authenticatedHermesGatewayUrl(
  endpoint: string,
  gatewayToken: string,
): string {
  const token = gatewayToken.trim();
  if (!token) throw new Error("Hermes gateway token is required");
  const url = new URL(normalizeHermesGatewayEndpoint(endpoint));
  url.searchParams.set("token", token);
  return url.toString();
}
