import crypto from "node:crypto";
import webpush from "web-push";
import type { PushNotificationPayload } from "@thechat/shared";
import type { WebPushConfig } from "./config";
import { isAllowedPushEndpoint } from "./endpoint";

export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export type PushSendOutcome =
  /** The push service accepted the message. This is not proof of display. */
  | { kind: "accepted"; status: number }
  /** The subscription no longer exists (404/410); delete it. */
  | { kind: "gone"; status: number }
  /** Rejected for this subscription (bad key, payload too large, ...). */
  | { kind: "rejected"; status: number }
  /** Temporary failure (429, 5xx, network, timeout); retry later. */
  | { kind: "retry"; status: number | null; retryAfterMs: number | null };

export interface PushRequest {
  url: string;
  headers: Record<string, string>;
  body: Uint8Array;
}

export type PushTransport = (request: PushRequest) => Promise<{
  status: number;
  headers: Headers;
}>;

const REQUEST_TIMEOUT_MS = 15_000;
/** Push services accept 4 KB; leave room for encryption overhead. */
export const MAX_PUSH_PAYLOAD_BYTES = 3_000;

const fetchTransport: PushTransport = async (request) => {
  const response = await fetch(request.url, {
    method: "POST",
    headers: request.headers,
    body: request.body,
    // Never follow a redirect away from the allowlisted push service.
    redirect: "manual",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  await response.arrayBuffer().catch(() => undefined);
  return { status: response.status, headers: response.headers };
};

let transport: PushTransport = fetchTransport;

export function setPushTransportForTests(next: PushTransport | null) {
  transport = next ?? fetchTransport;
}

export function encodePushPayload(payload: PushNotificationPayload): string {
  let encoded = JSON.stringify(payload);
  if (Buffer.byteLength(encoded) <= MAX_PUSH_PAYLOAD_BYTES) return encoded;
  // Long multi-byte text: shrink the body until it fits.
  let body = payload.body;
  while (body.length > 0 && Buffer.byteLength(encoded) > MAX_PUSH_PAYLOAD_BYTES) {
    body = `${body.slice(0, Math.floor(body.length * 0.8)).trimEnd()}…`;
    encoded = JSON.stringify({ ...payload, body });
  }
  return encoded;
}

export async function sendWebPush(
  target: PushTarget,
  payload: PushNotificationPayload,
  config: WebPushConfig,
  options: { urgency?: "normal" | "high"; topic?: string } = {},
): Promise<PushSendOutcome> {
  // Checked again here: rows could predate a tightened allowlist.
  if (!isAllowedPushEndpoint(target.endpoint)) return { kind: "gone", status: 0 };

  const details = webpush.generateRequestDetails(
    { endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } },
    encodePushPayload(payload),
    {
      vapidDetails: {
        subject: config.subject,
        publicKey: config.publicKey,
        privateKey: config.privateKey,
      },
      TTL: config.ttlSeconds,
      contentEncoding: "aes128gcm",
      urgency: options.urgency ?? "high",
      ...(options.topic ? { topic: options.topic } : {}),
    },
  );
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(details.headers)) {
    headers[name] = String(value);
  }

  let response: Awaited<ReturnType<PushTransport>>;
  try {
    response = await transport({
      url: details.endpoint,
      headers,
      body: details.body as Uint8Array,
    });
  } catch {
    return { kind: "retry", status: null, retryAfterMs: null };
  }
  const { status } = response;
  if (status >= 200 && status < 300) return { kind: "accepted", status };
  if (status === 404 || status === 410) return { kind: "gone", status };
  if (status === 429 || status >= 500) {
    return { kind: "retry", status, retryAfterMs: retryAfterMs(response.headers) };
  }
  return { kind: "rejected", status };
}

/**
 * Push-service topics replace an undelivered message with the same topic, so
 * a phone that is offline gets the latest state of a conversation, not a pile.
 * At most 32 URL-safe characters.
 */
export function pushTopic(tag: string): string {
  return crypto.createHash("sha256").update(tag).digest("base64url").slice(0, 32);
}

function retryAfterMs(headers: Headers): number | null {
  const value = headers.get("retry-after");
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds, 3_600) * 1_000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, Math.min(date - Date.now(), 3_600_000)) : null;
}
