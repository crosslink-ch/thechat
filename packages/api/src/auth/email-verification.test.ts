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

// ── Registration ──

describe("Email Verification: Registration", () => {
  test("returns message (not tokens) when verification required", async () => {
    const email = uniqueEmail();
    const res = await registerUser(email);

    expect(res.status).toBe(200);
    expect(res.body.message).toBeDefined();
    expect(res.body.accessToken).toBeUndefined();
    expect(res.body.refreshToken).toBeUndefined();
  });

  test("creates verification record in DB", async () => {
    const email = uniqueEmail();
    await registerUser(email);

    const [user] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    const [verification] = await db
      .select()
      .from(emailVerifications)
      .where(eq(emailVerifications.userId, user.id))
      .limit(1);

    expect(verification).toBeDefined();
    expect(verification.token).toBeTruthy();
    expect(verification.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });
});

// ── Login blocked ──

describe("Email Verification: Login blocked", () => {
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

// ── GET /verify-email ──

describe("Email Verification: GET /verify-email", () => {
  test("valid token verifies user, returns success HTML", async () => {
    const email = uniqueEmail();
    await registerUser(email);

    const [user] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    const [verification] = await db
      .select()
      .from(emailVerifications)
      .where(eq(emailVerifications.userId, user.id))
      .limit(1);

    const res = await req("GET", `/auth/verify-email?token=${verification.token}`);

    expect(res.status).toBe(200);
    expect(res.body).toContain("verified successfully");

    // User should now have emailVerifiedAt set
    const [updatedUser] = await db
      .select({ emailVerifiedAt: users.emailVerifiedAt })
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1);

    expect(updatedUser.emailVerifiedAt).toBeTruthy();

    // Verification record is intentionally NOT deleted on success — it ages
    // out via expiresAt so that email scanners pre-fetching the link don't
    // burn the token before the user clicks.
    const [stillThere] = await db
      .select()
      .from(emailVerifications)
      .where(eq(emailVerifications.userId, user.id))
      .limit(1);

    expect(stillThere).toBeDefined();
  });

  test("re-clicking the same valid link still succeeds (scanner pre-fetch safe)", async () => {
    const email = uniqueEmail();
    await registerUser(email);

    const [user] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    const [verification] = await db
      .select()
      .from(emailVerifications)
      .where(eq(emailVerifications.userId, user.id))
      .limit(1);

    // Simulate the scanner hitting the link first…
    const first = await req("GET", `/auth/verify-email?token=${verification.token}`);
    expect(first.status).toBe(200);
    expect(first.body).toContain("verified successfully");

    // …then the actual user clicking it.
    const second = await req("GET", `/auth/verify-email?token=${verification.token}`);
    expect(second.status).toBe(200);
    expect(second.body).toContain("verified successfully");

    // User remains verified.
    const [updatedUser] = await db
      .select({ emailVerifiedAt: users.emailVerifiedAt })
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1);
    expect(updatedUser.emailVerifiedAt).toBeTruthy();
  });

  test("invalid token returns 400", async () => {
    const res = await req("GET", "/auth/verify-email?token=bogus-token-that-does-not-exist");

    expect(res.status).toBe(400);
    expect(res.body).toContain("Invalid or expired");
  });

  test("missing token returns 400", async () => {
    const res = await req("GET", "/auth/verify-email");

    expect(res.status).toBe(400);
    expect(res.body).toContain("Invalid verification link");
  });

  test("expired token returns 400", async () => {
    const email = uniqueEmail();
    await registerUser(email);

    const [user] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    const [verification] = await db
      .select()
      .from(emailVerifications)
      .where(eq(emailVerifications.userId, user.id))
      .limit(1);

    // Manually expire the token
    await db
      .update(emailVerifications)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(emailVerifications.id, verification.id));

    const res = await req("GET", `/auth/verify-email?token=${verification.token}`);

    expect(res.status).toBe(400);
    expect(res.body).toContain("Invalid or expired");
  });
});

// ── Login after verify ──

describe("Email Verification: Login after verify", () => {
  test("login succeeds after email verified", async () => {
    const email = uniqueEmail();
    await registerUser(email);

    const [user] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    // Manually verify the user
    await db
      .update(users)
      .set({ emailVerifiedAt: new Date() })
      .where(eq(users.id, user.id));

    const res = await req("POST", "/auth/login", {
      email,
      password: "password123",
    });

    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeDefined();
    expect(res.body.refreshToken).toBeDefined();
  });
});

// ── Resend verification ──

describe("Email Verification: Resend", () => {
  test("returns consistent message for unverified user", async () => {
    const email = uniqueEmail();
    await registerUser(email);

    const res = await req("POST", "/auth/resend-verification", { email });

    expect(res.status).toBe(200);
    expect(res.body.message).toBeDefined();

    // New token should exist in DB
    const [user] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    const [verification] = await db
      .select()
      .from(emailVerifications)
      .where(eq(emailVerifications.userId, user.id))
      .limit(1);

    expect(verification).toBeDefined();
    expect(verification.token).toBeTruthy();
  });

  test("returns same message for nonexistent email (anti-enumeration)", async () => {
    const res = await req("POST", "/auth/resend-verification", {
      email: uniqueEmail(),
    });

    expect(res.status).toBe(200);
    expect(res.body.message).toBeDefined();
  });

  test("returns same message for already-verified user", async () => {
    const email = uniqueEmail();
    await registerUser(email);

    // Manually verify
    const [user] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    await db
      .update(users)
      .set({ emailVerifiedAt: new Date() })
      .where(eq(users.id, user.id));

    // Clean up any existing verification records
    await db
      .delete(emailVerifications)
      .where(eq(emailVerifications.userId, user.id));

    const res = await req("POST", "/auth/resend-verification", { email });

    expect(res.status).toBe(200);
    expect(res.body.message).toBeDefined();

    // No new verification record should be created
    const [verification] = await db
      .select()
      .from(emailVerifications)
      .where(eq(emailVerifications.userId, user.id))
      .limit(1);

    expect(verification).toBeUndefined();
  });
});

// ── Opportunistic cleanup of expired rows ──

describe("Email Verification: Opportunistic cleanup", () => {
  test("registering a new user purges other users' expired verification rows", async () => {
    // Stale user with an expired verification row.
    const staleEmail = uniqueEmail();
    await registerUser(staleEmail);

    const [staleUser] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, staleEmail))
      .limit(1);

    const [staleVerification] = await db
      .select()
      .from(emailVerifications)
      .where(eq(emailVerifications.userId, staleUser.id))
      .limit(1);

    await db
      .update(emailVerifications)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(emailVerifications.id, staleVerification.id));

    // Bypass the 15-min throttle so the next register triggers a real sweep.
    __resetCleanupThrottleForTests();

    // A fresh registration should sweep the expired row away.
    await registerUser(uniqueEmail());

    const [shouldBeGone] = await db
      .select()
      .from(emailVerifications)
      .where(eq(emailVerifications.id, staleVerification.id))
      .limit(1);

    expect(shouldBeGone).toBeUndefined();
  });

  test("resending verification purges other users' expired rows", async () => {
    // Stale user with an expired verification row.
    const staleEmail = uniqueEmail();
    await registerUser(staleEmail);

    const [staleUser] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, staleEmail))
      .limit(1);

    const [staleVerification] = await db
      .select()
      .from(emailVerifications)
      .where(eq(emailVerifications.userId, staleUser.id))
      .limit(1);

    await db
      .update(emailVerifications)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(emailVerifications.id, staleVerification.id));

    // A different user resending should sweep the expired row away.
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
    // Stale user A with an expired verification row.
    const staleEmail = uniqueEmail();
    await registerUser(staleEmail);

    const [staleUser] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, staleEmail))
      .limit(1);

    const [staleVerification] = await db
      .select()
      .from(emailVerifications)
      .where(eq(emailVerifications.userId, staleUser.id))
      .limit(1);

    // First register triggers a real sweep and arms the throttle.
    __resetCleanupThrottleForTests();
    await registerUser(uniqueEmail());

    // Now expire user A's row AFTER the throttle is armed.
    await db
      .update(emailVerifications)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(emailVerifications.id, staleVerification.id));

    // A second register inside the 15-min window must NOT sweep — the
    // expired row should still be there.
    await registerUser(uniqueEmail());

    const [stillThere] = await db
      .select()
      .from(emailVerifications)
      .where(eq(emailVerifications.id, staleVerification.id))
      .limit(1);

    expect(stillThere).toBeDefined();
  });
});
