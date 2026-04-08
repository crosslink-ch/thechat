// Enable email verification behavior for this file only.
const previousRequireEmailVerification = process.env.REQUIRE_EMAIL_VERIFICATION;
process.env.REQUIRE_EMAIL_VERIFICATION = "true";

import { describe, test, expect, afterAll } from "bun:test";
import { Elysia } from "elysia";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { users, emailVerifications } from "../db/schema";
import crypto from "crypto";

const { authRoutes, __resetCleanupThrottleForTests } = await import("./index");
const app = new Elysia().use(authRoutes);

function uniqueEmail() {
  return `test-${crypto.randomUUID()}@test.com`;
}

const createdUserEmails: string[] = [];

async function cleanup() {
  for (const email of createdUserEmails) {
    const [user] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    if (user) {
      await db.delete(users).where(eq(users.id, user.id));
    }
  }
}

afterAll(async () => {
  await cleanup();
  if (previousRequireEmailVerification === undefined) {
    delete process.env.REQUIRE_EMAIL_VERIFICATION;
  } else {
    process.env.REQUIRE_EMAIL_VERIFICATION = previousRequireEmailVerification;
  }
});

async function req(
  method: string,
  path: string,
  body?: unknown,
  token?: string
) {
  const headers: Record<string, string> = {};
  if (body) headers["Content-Type"] = "application/json";
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const response = await app.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    })
  );

  const text = await response.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: response.status, body: json };
}

async function registerUser(email: string, name = "Test User") {
  createdUserEmails.push(email);
  return req("POST", "/auth/register", {
    name,
    email,
    password: "password123",
  });
}

// Pulls the freshly-issued OTP straight out of the DB. Real users would read
// it from their inbox; tests skip the email round-trip.
async function fetchOtpForEmail(email: string): Promise<string> {
  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (!user) throw new Error(`no user for ${email}`);

  const [verification] = await db
    .select()
    .from(emailVerifications)
    .where(eq(emailVerifications.userId, user.id))
    .limit(1);
  if (!verification) throw new Error(`no verification row for ${email}`);

  return verification.code;
}

async function getUserId(email: string): Promise<string> {
  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (!user) throw new Error(`no user for ${email}`);
  return user.id;
}

// ── Registration ──

describe("Email Verification: Registration", () => {
  test("returns message (not tokens) when verification required", async () => {
    const email = uniqueEmail();
    const res = await registerUser(email);

    expect(res.status).toBe(200);
    expect(res.body.message).toBeDefined();
    expect(res.body.message).toContain("code");
    expect(res.body.accessToken).toBeUndefined();
    expect(res.body.refreshToken).toBeUndefined();
  });

  test("creates a 6-digit code with a future expiry", async () => {
    const email = uniqueEmail();
    await registerUser(email);

    const userId = await getUserId(email);
    const [verification] = await db
      .select()
      .from(emailVerifications)
      .where(eq(emailVerifications.userId, userId))
      .limit(1);

    expect(verification).toBeDefined();
    expect(verification.code).toMatch(/^\d{6}$/);
    expect(verification.attempts).toBe(0);
    expect(verification.expiresAt.getTime()).toBeGreaterThan(Date.now());

    // 15-minute TTL — allow a bit of slack on both sides for clock + I/O.
    const ttlMs = verification.expiresAt.getTime() - Date.now();
    expect(ttlMs).toBeGreaterThan(14 * 60 * 1000);
    expect(ttlMs).toBeLessThanOrEqual(15 * 60 * 1000 + 5000);
  });

  test("the email body for an unrelated request never contains a clickable URL", async () => {
    // We don't actually intercept the SMTP send here, but we can prove the
    // sender helper builds a code-only template by importing it directly and
    // inspecting the rendered HTML through a stub.
    const { sendVerificationCode } = await import("./email");
    let capturedHtml = "";
    const original = (globalThis as any).fetch;
    // The Postmark transport uses fetch; the SMTP transport uses nodemailer.
    // Stub fetch and force the postmark path so we can capture the body.
    process.env.EMAIL_PROVIDER = "postmark";
    process.env.POSTMARK_API_TOKEN = "test-token";
    (globalThis as any).fetch = async (_url: string, init: any) => {
      const body = JSON.parse(init.body);
      capturedHtml = body.HtmlBody;
      return new Response("{}", { status: 200 });
    };
    try {
      await sendVerificationCode("anyone@test.com", "123456");
    } finally {
      (globalThis as any).fetch = original;
      delete process.env.EMAIL_PROVIDER;
      delete process.env.POSTMARK_API_TOKEN;
    }

    expect(capturedHtml).toContain("123456");
    // The whole point of OTP: no link a scanner can pre-fetch.
    expect(capturedHtml).not.toMatch(/<a\s/i);
    expect(capturedHtml).not.toMatch(/href\s*=/i);
    expect(capturedHtml).not.toContain("verify-email");
  });
});

// ── Login blocked ──

describe("Email Verification: Login blocked until verified", () => {
  test("returns 403 for unverified user", async () => {
    const email = uniqueEmail();
    await registerUser(email);

    const res = await req("POST", "/auth/login", {
      email,
      password: "password123",
    });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("verify");
  });
});

// ── POST /verify-email-otp ──

describe("Email Verification: POST /verify-email-otp", () => {
  test("correct code verifies the user, deletes the row, and returns session tokens", async () => {
    const email = uniqueEmail();
    await registerUser(email);
    const code = await fetchOtpForEmail(email);
    const userId = await getUserId(email);

    const res = await req("POST", "/auth/verify-email-otp", { email, code });

    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.refreshToken).toBeTruthy();
    expect(res.body.user?.email).toBe(email);

    // emailVerifiedAt was flipped.
    const [updated] = await db
      .select({ emailVerifiedAt: users.emailVerifiedAt })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    expect(updated.emailVerifiedAt).toBeTruthy();

    // Verification row was consumed (safe to delete on success — no scanner
    // pre-fetch concern with OTP).
    const [gone] = await db
      .select()
      .from(emailVerifications)
      .where(eq(emailVerifications.userId, userId))
      .limit(1);
    expect(gone).toBeUndefined();
  });

  test("after successful verify, the user can log in normally", async () => {
    const email = uniqueEmail();
    await registerUser(email);
    const code = await fetchOtpForEmail(email);
    await req("POST", "/auth/verify-email-otp", { email, code });

    const res = await req("POST", "/auth/login", {
      email,
      password: "password123",
    });

    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
  });

  test("wrong code returns 400 and increments attempts", async () => {
    const email = uniqueEmail();
    await registerUser(email);
    const userId = await getUserId(email);

    const res = await req("POST", "/auth/verify-email-otp", {
      email,
      code: "000000",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Invalid or expired");

    const [verification] = await db
      .select()
      .from(emailVerifications)
      .where(eq(emailVerifications.userId, userId))
      .limit(1);
    expect(verification).toBeDefined();
    expect(verification.attempts).toBe(1);

    // User is still unverified.
    const [stillUnverified] = await db
      .select({ emailVerifiedAt: users.emailVerifiedAt })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    expect(stillUnverified.emailVerifiedAt).toBeNull();
  });

  test("after 5 wrong attempts, the row is burned and even the correct code fails", async () => {
    const email = uniqueEmail();
    await registerUser(email);
    const realCode = await fetchOtpForEmail(email);
    const userId = await getUserId(email);

    // Find a wrong code that is guaranteed not to equal the real one.
    const wrongCode = realCode === "000000" ? "111111" : "000000";

    for (let i = 0; i < 5; i++) {
      const res = await req("POST", "/auth/verify-email-otp", {
        email,
        code: wrongCode,
      });
      expect(res.status).toBe(400);
    }

    // Confirm the row is now at the limit.
    const [pre] = await db
      .select()
      .from(emailVerifications)
      .where(eq(emailVerifications.userId, userId))
      .limit(1);
    expect(pre).toBeDefined();
    expect(pre.attempts).toBe(5);

    // The 6th attempt — even with the correct code — must fail with the
    // "too many attempts" error and burn the row.
    const burned = await req("POST", "/auth/verify-email-otp", {
      email,
      code: realCode,
    });
    expect(burned.status).toBe(400);
    expect(burned.body.error).toContain("Too many");

    const [post] = await db
      .select()
      .from(emailVerifications)
      .where(eq(emailVerifications.userId, userId))
      .limit(1);
    expect(post).toBeUndefined();

    // Subsequent attempt with the (now-deleted) correct code falls through
    // to the generic error.
    const after = await req("POST", "/auth/verify-email-otp", {
      email,
      code: realCode,
    });
    expect(after.status).toBe(400);
    expect(after.body.error).toContain("Invalid or expired");

    // User is still unverified.
    const [stillUnverified] = await db
      .select({ emailVerifiedAt: users.emailVerifiedAt })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    expect(stillUnverified.emailVerifiedAt).toBeNull();
  });

  test("expired code returns 400 (treated as invalid)", async () => {
    const email = uniqueEmail();
    await registerUser(email);
    const code = await fetchOtpForEmail(email);
    const userId = await getUserId(email);

    // Manually expire the row.
    await db
      .update(emailVerifications)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(emailVerifications.userId, userId));

    const res = await req("POST", "/auth/verify-email-otp", { email, code });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Invalid or expired");

    // Still unverified.
    const [stillUnverified] = await db
      .select({ emailVerifiedAt: users.emailVerifiedAt })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    expect(stillUnverified.emailVerifiedAt).toBeNull();
  });

  test("malformed code (not 6 digits) returns 400 with a validation message", async () => {
    const email = uniqueEmail();
    await registerUser(email);

    const cases = ["12345", "1234567", "abcdef", "12 345", ""];
    for (const code of cases) {
      const res = await req("POST", "/auth/verify-email-otp", { email, code });
      expect(res.status).toBe(400);
    }

    // The bad attempts go to the validator, not the code-check, so the row's
    // attempts counter must remain at 0.
    const userId = await getUserId(email);
    const [verification] = await db
      .select()
      .from(emailVerifications)
      .where(eq(emailVerifications.userId, userId))
      .limit(1);
    expect(verification.attempts).toBe(0);
  });

  test("verifying with a code that belongs to a different user fails", async () => {
    const aliceEmail = uniqueEmail();
    const bobEmail = uniqueEmail();
    await registerUser(aliceEmail);
    await registerUser(bobEmail);

    const aliceCode = await fetchOtpForEmail(aliceEmail);

    // Submit Alice's code under Bob's email — must not verify Bob.
    const res = await req("POST", "/auth/verify-email-otp", {
      email: bobEmail,
      code: aliceCode,
    });
    expect(res.status).toBe(400);

    const bobId = await getUserId(bobEmail);
    const [bob] = await db
      .select({ emailVerifiedAt: users.emailVerifiedAt })
      .from(users)
      .where(eq(users.id, bobId))
      .limit(1);
    expect(bob.emailVerifiedAt).toBeNull();

    // Alice's code is still usable on Alice's account.
    const aliceVerify = await req("POST", "/auth/verify-email-otp", {
      email: aliceEmail,
      code: aliceCode,
    });
    expect(aliceVerify.status).toBe(200);
    expect(aliceVerify.body.accessToken).toBeTruthy();
  });

  test("nonexistent email returns the same generic error (no enumeration)", async () => {
    const res = await req("POST", "/auth/verify-email-otp", {
      email: uniqueEmail(),
      code: "123456",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Invalid or expired");
  });
});

// ── Resend verification ──

describe("Email Verification: Resend", () => {
  test("returns consistent message and creates a fresh code", async () => {
    const email = uniqueEmail();
    await registerUser(email);
    const firstCode = await fetchOtpForEmail(email);

    const res = await req("POST", "/auth/resend-verification", { email });
    expect(res.status).toBe(200);
    expect(res.body.message).toBeDefined();

    const userId = await getUserId(email);
    const [verification] = await db
      .select()
      .from(emailVerifications)
      .where(eq(emailVerifications.userId, userId))
      .limit(1);
    expect(verification).toBeDefined();
    expect(verification.code).toMatch(/^\d{6}$/);
    // Almost certainly different — there's a 1-in-a-million chance the same
    // code is regenerated, which would be a flake. We accept that as a
    // realistic statistical tradeoff.
    expect(verification.code).not.toBe(firstCode);
    expect(verification.attempts).toBe(0);
  });

  test("resending invalidates the old code (old code can no longer verify)", async () => {
    const email = uniqueEmail();
    await registerUser(email);
    const oldCode = await fetchOtpForEmail(email);

    await req("POST", "/auth/resend-verification", { email });

    const res = await req("POST", "/auth/verify-email-otp", {
      email,
      code: oldCode,
    });
    // The old code is gone — same generic error.
    // (Tiny chance of collision with the regenerated code; ignored.)
    expect(res.status).toBe(400);
  });

  test("resending clears a previous burned attempts counter", async () => {
    const email = uniqueEmail();
    await registerUser(email);
    const userId = await getUserId(email);

    // Burn 3 attempts on the original code.
    for (let i = 0; i < 3; i++) {
      await req("POST", "/auth/verify-email-otp", { email, code: "000000" });
    }
    const [pre] = await db
      .select()
      .from(emailVerifications)
      .where(eq(emailVerifications.userId, userId))
      .limit(1);
    expect(pre.attempts).toBe(3);

    await req("POST", "/auth/resend-verification", { email });

    const [post] = await db
      .select()
      .from(emailVerifications)
      .where(eq(emailVerifications.userId, userId))
      .limit(1);
    expect(post.attempts).toBe(0);

    // The new code works on the first try.
    const newCode = post.code;
    const verify = await req("POST", "/auth/verify-email-otp", {
      email,
      code: newCode,
    });
    expect(verify.status).toBe(200);
  });

  test("returns same message for nonexistent email (anti-enumeration)", async () => {
    const res = await req("POST", "/auth/resend-verification", {
      email: uniqueEmail(),
    });

    expect(res.status).toBe(200);
    expect(res.body.message).toBeDefined();
  });

  test("returns same message for already-verified user and creates no new row", async () => {
    const email = uniqueEmail();
    await registerUser(email);
    const code = await fetchOtpForEmail(email);
    await req("POST", "/auth/verify-email-otp", { email, code });
    const userId = await getUserId(email);

    const res = await req("POST", "/auth/resend-verification", { email });

    expect(res.status).toBe(200);
    expect(res.body.message).toBeDefined();

    const [verification] = await db
      .select()
      .from(emailVerifications)
      .where(eq(emailVerifications.userId, userId))
      .limit(1);

    expect(verification).toBeUndefined();
  });
});

// ── Opportunistic cleanup of expired rows ──

describe("Email Verification: Opportunistic cleanup", () => {
  test("registering a new user purges other users' expired verification rows", async () => {
    // Stale user with a row that we'll expire.
    const staleEmail = uniqueEmail();
    await registerUser(staleEmail);
    const staleUserId = await getUserId(staleEmail);

    const [staleVerification] = await db
      .select()
      .from(emailVerifications)
      .where(eq(emailVerifications.userId, staleUserId))
      .limit(1);

    await db
      .update(emailVerifications)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(emailVerifications.id, staleVerification.id));

    // Bypass the 15-min throttle so the next register triggers a real sweep.
    __resetCleanupThrottleForTests();

    await registerUser(uniqueEmail());

    const [shouldBeGone] = await db
      .select()
      .from(emailVerifications)
      .where(eq(emailVerifications.id, staleVerification.id))
      .limit(1);

    expect(shouldBeGone).toBeUndefined();
  });

  test("resending verification purges other users' expired rows", async () => {
    const staleEmail = uniqueEmail();
    await registerUser(staleEmail);
    const staleUserId = await getUserId(staleEmail);

    const [staleVerification] = await db
      .select()
      .from(emailVerifications)
      .where(eq(emailVerifications.userId, staleUserId))
      .limit(1);

    await db
      .update(emailVerifications)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(emailVerifications.id, staleVerification.id));

    const liveEmail = uniqueEmail();
    await registerUser(liveEmail);
    __resetCleanupThrottleForTests();
    await req("POST", "/auth/resend-verification", { email: liveEmail });

    const [shouldBeGone] = await db
      .select()
      .from(emailVerifications)
      .where(eq(emailVerifications.id, staleVerification.id))
      .limit(1);

    expect(shouldBeGone).toBeUndefined();
  });

  test("cleanup is throttled — back-to-back registers within the window do not re-sweep", async () => {
    const staleEmail = uniqueEmail();
    await registerUser(staleEmail);
    const staleUserId = await getUserId(staleEmail);

    const [staleVerification] = await db
      .select()
      .from(emailVerifications)
      .where(eq(emailVerifications.userId, staleUserId))
      .limit(1);

    // First register triggers a real sweep and arms the throttle.
    __resetCleanupThrottleForTests();
    await registerUser(uniqueEmail());

    // Now expire user A's row AFTER the throttle is armed.
    await db
      .update(emailVerifications)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(emailVerifications.id, staleVerification.id));

    // A second register inside the 15-min window must NOT sweep.
    await registerUser(uniqueEmail());

    const [stillThere] = await db
      .select()
      .from(emailVerifications)
      .where(eq(emailVerifications.id, staleVerification.id))
      .limit(1);

    expect(stillThere).toBeDefined();
  });
});
