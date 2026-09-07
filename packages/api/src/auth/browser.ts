import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";

const nativeOrigins = new Set([
  "tauri://localhost",
  "http://tauri.localhost",
  "https://tauri.localhost",
]);
const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);

function browserCookieSettings(origin: string | null | undefined) {
  try {
    const backend = new URL(
      process.env.BETTER_AUTH_URL ??
        process.env.THECHAT_BACKEND_URL ??
        "http://localhost:3000",
    );
    const client = new URL(origin ?? "");
    if (backend.protocol === "https:" && client.protocol === "https:")
      return { name: "__Host-thechat_session", secure: true };
    if (
      process.env.NODE_ENV !== "production" &&
      process.env.THECHAT_WEB_ALLOW_INSECURE_LOOPBACK === "true" &&
      backend.protocol === "http:" &&
      client.protocol === "http:" &&
      loopbackHosts.has(backend.hostname) &&
      loopbackHosts.has(client.hostname)
    ) {
      return { name: "thechat_session", secure: false };
    }
  } catch {
    /* Fail closed for missing/malformed deployment configuration. */
  }
  return null;
}

/** Exact origins only: no wildcard, suffix matching, path, credentials or proxy authority. */
export function trustedWebOrigin(origin: string | null | undefined): boolean {
  if (!origin || origin === "null") return false;
  return (process.env.THECHAT_WEB_ORIGINS ?? "").split(",").some((entry) => {
    const configured = entry.trim();
    try {
      const url = new URL(configured);
      return (
        url.origin === configured &&
        ["https:", "http:"].includes(url.protocol) &&
        configured === origin &&
        browserCookieSettings(origin) !== null
      );
    } catch {
      return false;
    }
  });
}

export function isWebClient(headers: Record<string, string | undefined>) {
  return headers["x-thechat-client"] === "web";
}

export function browserSessionCookie(
  token: string,
  origin: string | undefined,
) {
  const settings = browserCookieSettings(origin);
  if (!settings)
    throw new Error("Browser cookie transport is not configured securely");
  return `${settings.name}=${encodeURIComponent(token)}; Path=/; HttpOnly; ${settings.secure ? "Secure; " : ""}SameSite=Lax; Max-Age=${token ? 2592000 : 0}`;
}

export function browserSessionToken(
  headers: Record<string, string | undefined>,
) {
  if (
    !isWebClient(headers) ||
    !trustedWebOrigin(headers.origin) ||
    headers["sec-fetch-site"] === "cross-site"
  )
    return null;
  const prefix = `${browserCookieSettings(headers.origin)!.name}=`;
  const values = (headers.cookie ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(prefix));
  if (values.length !== 1) return null;
  try {
    return decodeURIComponent(values[0]!.slice(prefix.length)) || null;
  } catch {
    return null;
  }
}

function effectiveBrowserOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (origin !== null) return origin;
  // Browsers omit Origin on same-origin reads. Accept only browser Fetch
  // Metadata plus a Referer bound to the explicitly configured public API,
  // never the request Host or forwarded headers. Mutations cannot use this.
  if (
    !["GET", "HEAD"].includes(request.method) ||
    request.headers.get("sec-fetch-site") !== "same-origin"
  )
    return null;
  try {
    const referer = new URL(request.headers.get("referer") ?? "");
    const backend = new URL(
      process.env.BETTER_AUTH_URL ??
        process.env.THECHAT_BACKEND_URL ??
        "http://localhost:3000",
    );
    return referer.origin === backend.origin ? referer.origin : null;
  } catch {
    return null;
  }
}

export const browserCors = new Elysia({ name: "browser-cors" })
  .onRequest(({ request, set }) => {
    if (trustedWebOrigin(request.headers.get("origin"))) {
      set.headers["access-control-allow-credentials"] = "true";
    }
  })
  .use(
    cors({
      origin: (request) =>
        trustedWebOrigin(request.headers.get("origin")) ||
        nativeOrigins.has(request.headers.get("origin") ?? ""),
      credentials: false,
      allowedHeaders: ["Content-Type", "Authorization", "X-TheChat-Client"],
      exposeHeaders: ["Retry-After", "X-Retry-After"],
      methods: ["GET", "HEAD", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    }),
  )
  .as("scoped");

/** Check before any auth endpoint work, including login/session minting. */
export const browserAuthPolicy = new Elysia({ name: "browser-auth-policy" })
  .use(browserCors)
  .onRequest(({ request, set }) => {
    // WebSocket clients cannot set the HTTP browser marker. /ws validates the
    // original handshake Origin and cookie when processing its cookie frame.
    if (
      request.method === "GET" &&
      new URL(request.url).pathname === "/ws" &&
      request.headers.get("upgrade")?.toLowerCase() === "websocket"
    )
      return;
    const marker = request.headers.get("x-thechat-client");
    const origin = effectiveBrowserOrigin(request);
    const hasCookie =
      /(?:^|;\s*)(?:__Host-thechat_session|thechat_session)=/.test(
        request.headers.get("cookie") ?? "",
      );
    if (!marker && !hasCookie && (!origin || nativeOrigins.has(origin))) return;
    if (
      marker === "web" &&
      trustedWebOrigin(origin) &&
      request.headers.get("sec-fetch-site") !== "cross-site"
    )
      return;
    set.status = 403;
    return {
      error: "Trusted browser origin and X-TheChat-Client: web required",
    };
  })
  .onTransform(({ request, headers }) => {
    // Only the validated context is normalized; the original handshake/request
    // is unchanged, and unsafe methods must always carry an actual Origin.
    if (isWebClient(headers) && !headers.origin) {
      const origin = effectiveBrowserOrigin(request);
      if (trustedWebOrigin(origin)) headers.origin = origin!;
    }
  })
  .as("scoped");
