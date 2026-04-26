import { describe, test, expect } from "bun:test";
import crypto from "node:crypto";
import { computeSignature, verifyWebhook } from "./signature.js";

const SECRET = "whsec_test_secret_value_0123456789abcdef";

function sign(body: string, ts: number, secret = SECRET): string {
  return crypto
    .createHmac("sha256", secret)
    .update(`${ts}.${body}`)
    .digest("hex");
}

describe("computeSignature", () => {
  test("matches a hand-rolled HMAC-SHA256", () => {
    const body = JSON.stringify({ hello: "world" });
    const ts = 1_700_000_000;
    expect(computeSignature({ body, timestamp: ts, secret: SECRET })).toBe(
      sign(body, ts)
    );
  });

  test("different secret yields different signature", () => {
    const body = "x";
    const ts = 1_700_000_000;
    const a = computeSignature({ body, timestamp: ts, secret: SECRET });
    const b = computeSignature({ body, timestamp: ts, secret: "other" });
    expect(a).not.toBe(b);
  });
});

describe("verifyWebhook", () => {
  const body = JSON.stringify({ msg: "hi" });
  const now = 1_700_000_000;

  test("accepts a freshly signed body", () => {
    const ts = now;
    const sig = sign(body, ts);
    const r = verifyWebhook({
      body,
      signatureHeader: sig,
      timestampHeader: String(ts),
      secret: SECRET,
      nowSeconds: () => now,
    });
    expect(r.ok).toBe(true);
  });

  test("rejects a wrong signature", () => {
    const ts = now;
    const r = verifyWebhook({
      body,
      signatureHeader: sign(body, ts) + "00",
      timestampHeader: String(ts),
      secret: SECRET,
      nowSeconds: () => now,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("bad_signature");
  });

  test("rejects a body tampered with after signing", () => {
    const ts = now;
    const sig = sign(body, ts);
    const tampered = body.replace("hi", "bye");
    const r = verifyWebhook({
      body: tampered,
      signatureHeader: sig,
      timestampHeader: String(ts),
      secret: SECRET,
      nowSeconds: () => now,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("bad_signature");
  });

  test("rejects a stale timestamp (replay window exceeded)", () => {
    const ts = now - 1000;
    const sig = sign(body, ts);
    const r = verifyWebhook({
      body,
      signatureHeader: sig,
      timestampHeader: String(ts),
      secret: SECRET,
      maxClockSkewSeconds: 300,
      nowSeconds: () => now,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("stale_timestamp");
  });

  test("rejects a future timestamp beyond window", () => {
    const ts = now + 1000;
    const sig = sign(body, ts);
    const r = verifyWebhook({
      body,
      signatureHeader: sig,
      timestampHeader: String(ts),
      secret: SECRET,
      maxClockSkewSeconds: 300,
      nowSeconds: () => now,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("stale_timestamp");
  });

  test("accepts within configured skew", () => {
    const ts = now - 60;
    const r = verifyWebhook({
      body,
      signatureHeader: sign(body, ts),
      timestampHeader: String(ts),
      secret: SECRET,
      maxClockSkewSeconds: 300,
      nowSeconds: () => now,
    });
    expect(r.ok).toBe(true);
  });

  test("rejects missing signature header", () => {
    const r = verifyWebhook({
      body,
      signatureHeader: undefined,
      timestampHeader: String(now),
      secret: SECRET,
      nowSeconds: () => now,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("missing_headers");
  });

  test("rejects missing timestamp header", () => {
    const r = verifyWebhook({
      body,
      signatureHeader: sign(body, now),
      timestampHeader: null,
      secret: SECRET,
      nowSeconds: () => now,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("missing_headers");
  });

  test("rejects non-numeric timestamp", () => {
    const r = verifyWebhook({
      body,
      signatureHeader: sign(body, now),
      timestampHeader: "not-a-number",
      secret: SECRET,
      nowSeconds: () => now,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("invalid_timestamp");
  });

  test("rejects signature signed with different secret", () => {
    const ts = now;
    const sig = sign(body, ts, "other-secret");
    const r = verifyWebhook({
      body,
      signatureHeader: sig,
      timestampHeader: String(ts),
      secret: SECRET,
      nowSeconds: () => now,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("bad_signature");
  });
});
