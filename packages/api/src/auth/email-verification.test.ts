// Must set env BEFORE importing auth routes — requireEmailVerification is
// captured as a module-level const at import time. Static imports are hoisted
// above this assignment, so we use dynamic import() for authRoutes.
process.env.REQUIRE_EMAIL_VERIFICATION = "true";

import { describe, test, expect, afterAll } from "bun:test";
import { Elysia } from "elysia";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { users, emailVerifications } from "../db/schema";
import crypto from "crypto";

const { authRoutes } = await import("./index");
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

afterAll(cleanup);

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

    // Verification record should be deleted
    const [deleted] = await db
      .select()
      .from(emailVerifications)
      .where(eq(emailVerifications.userId, user.id))
      .limit(1);

    expect(deleted).toBeUndefined();
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
