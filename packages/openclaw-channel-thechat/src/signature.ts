import crypto from "node:crypto";

/**
 * Compute the HMAC-SHA256 signature TheChat uses for outbound webhooks.
 *
 * Signed content is `${timestamp}.${body}`. Including the timestamp inside
 * the signed content prevents replay of (signature, body) pairs with a
 * different timestamp, and matches the convention used by Stripe-style
 * webhook signing.
 */
export function computeSignature(args: {
  body: string;
  timestamp: number | string;
  secret: string;
}): string {
  const { body, timestamp, secret } = args;
  const signedContent = `${timestamp}.${body}`;
  return crypto
    .createHmac("sha256", secret)
    .update(signedContent)
    .digest("hex");
}

/**
 * Constant-time comparison of two hex strings of arbitrary length. Uses a
 * length-mismatch guard outside the timingSafeEqual call so we don't
 * short-circuit early.
 */
function constantTimeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  // Pad both to the longer length so timingSafeEqual sees equal-length input.
  const max = Math.max(aBuf.length, bBuf.length);
  const aPad = Buffer.alloc(max);
  const bPad = Buffer.alloc(max);
  aBuf.copy(aPad);
  bBuf.copy(bPad);
  const eq = crypto.timingSafeEqual(aPad, bPad);
  // Re-introduce the length check AFTER the constant-time compare so callers
  // can't infer a length mismatch from timing.
  return eq && aBuf.length === bBuf.length;
}

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: "missing_headers" | "invalid_timestamp" | "stale_timestamp" | "bad_signature" };

/**
 * Verify a webhook signature plus timestamp staleness. The caller MUST pass
 * the raw body string exactly as received (no re-stringification — JSON
 * canonicalization can change byte order).
 *
 * `nowSeconds` is injectable so tests can pin a deterministic clock.
 */
export function verifyWebhook(args: {
  body: string;
  signatureHeader: string | null | undefined;
  timestampHeader: string | null | undefined;
  secret: string;
  /** Maximum allowed age (in seconds) between the request timestamp and now. */
  maxClockSkewSeconds?: number;
  /** Injectable clock for tests. Defaults to Date.now / 1000. */
  nowSeconds?: () => number;
}): VerifyResult {
  const {
    body,
    signatureHeader,
    timestampHeader,
    secret,
    maxClockSkewSeconds = 300,
    nowSeconds = () => Math.floor(Date.now() / 1000),
  } = args;

  if (!signatureHeader || !timestampHeader) {
    return { ok: false, reason: "missing_headers" };
  }

  const timestamp = Number(timestampHeader);
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return { ok: false, reason: "invalid_timestamp" };
  }

  const skew = Math.abs(nowSeconds() - timestamp);
  if (skew > maxClockSkewSeconds) {
    return { ok: false, reason: "stale_timestamp" };
  }

  const expected = computeSignature({ body, timestamp, secret });
  if (!constantTimeEqual(expected, signatureHeader.trim())) {
    return { ok: false, reason: "bad_signature" };
  }

  return { ok: true };
}
