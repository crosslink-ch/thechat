import { shouldDispatch } from "./gating.js";
import { verifyWebhook, type VerifyResult } from "./signature.js";
import { deriveSessionMapping, type SessionMapping } from "./session.js";
import type { TheChatChannelConfig, TheChatWebhookPayload } from "./types.js";

export type SkipReason =
  | "own_message"
  | "other_bot_blocked"
  | "sender_not_allowed"
  | "channel_mention_required"
  | "unknown_event";

export type InboundOutcome =
  | { kind: "dispatched"; payload: TheChatWebhookPayload; mapping: SessionMapping }
  | { kind: "rejected"; status: number; reason: string }
  | { kind: "skipped"; reason: SkipReason };

export interface HandleInboundArgs {
  /** Raw request body. MUST be the original bytes — do not re-stringify. */
  body: string;
  headers: Record<string, string | null | undefined>;
  config: TheChatChannelConfig;
  /** Injectable clock for tests. */
  nowSeconds?: () => number;
  /** Optional structured logger. */
  log?: (level: "info" | "warn", msg: string, fields?: Record<string, unknown>) => void;
}

function readHeader(
  headers: Record<string, string | null | undefined>,
  name: string
): string | null {
  // HTTP headers are case-insensitive. Normalize lookup.
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) {
      const v = headers[key];
      return v ?? null;
    }
  }
  return null;
}

/**
 * End-to-end inbound webhook handler. Verifies the HMAC signature and
 * timestamp, parses the payload, applies gating rules, and either returns
 * a dispatch directive (with the OpenClaw session mapping) or a structured
 * rejection/skip the caller can translate into an HTTP response and a log
 * line.
 *
 * This function does NOT touch OpenClaw's runtime — it returns a pure
 * description of what should happen. Wiring it into `api.dispatchInbound`
 * (or your channel's inbound queue) is the caller's job.
 */
export function handleInbound(args: HandleInboundArgs): InboundOutcome {
  const { body, headers, config, nowSeconds, log } = args;

  const verification: VerifyResult = verifyWebhook({
    body,
    signatureHeader: readHeader(headers, "X-Webhook-Signature"),
    timestampHeader: readHeader(headers, "X-Webhook-Timestamp"),
    secret: config.webhookSecret,
    maxClockSkewSeconds: config.maxClockSkewSeconds,
    nowSeconds,
  });

  if (!verification.ok) {
    log?.("warn", "thechat.inbound.verify_failed", {
      reason: verification.reason,
    });
    const status = verification.reason === "missing_headers" ? 400 : 401;
    return { kind: "rejected", status, reason: verification.reason };
  }

  let payload: TheChatWebhookPayload;
  try {
    payload = JSON.parse(body) as TheChatWebhookPayload;
  } catch {
    log?.("warn", "thechat.inbound.invalid_json");
    return { kind: "rejected", status: 400, reason: "invalid_json" };
  }

  if (
    !payload ||
    typeof payload !== "object" ||
    !payload.event ||
    !payload.message ||
    !payload.conversation ||
    !payload.bot
  ) {
    log?.("warn", "thechat.inbound.malformed_payload");
    return { kind: "rejected", status: 400, reason: "malformed_payload" };
  }

  // Defense-in-depth: don't accept payloads addressed to a different bot,
  // even if the secret happens to be shared (it shouldn't be).
  if (payload.bot.id !== config.botId) {
    log?.("warn", "thechat.inbound.wrong_bot", {
      payloadBotId: payload.bot.id,
      configuredBotId: config.botId,
    });
    return { kind: "rejected", status: 400, reason: "wrong_bot" };
  }

  const decision = shouldDispatch(payload, config);
  if (!decision.dispatch) {
    log?.("info", "thechat.inbound.skipped", {
      reason: decision.reason,
      event: payload.event,
      conversationKind: payload.conversation.kind,
      senderType: payload.message.senderType,
    });
    return { kind: "skipped", reason: decision.reason };
  }

  const mapping = deriveSessionMapping(payload);
  log?.("info", "thechat.inbound.dispatched", {
    event: payload.event,
    conversationKind: payload.conversation.kind,
    target: mapping.to,
    sessionKey: mapping.sessionKey,
  });

  return { kind: "dispatched", payload, mapping };
}
