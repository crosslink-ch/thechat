const previousEnv = {
  nodeEnv: process.env.NODE_ENV,
  secret: process.env.BETTER_AUTH_SECRET,
  enabled: process.env.BETTER_AUTH_RATE_LIMIT_ENABLED,
  trustProxy: process.env.AUTH_TRUST_PROXY,
  requireEmailVerification: process.env.REQUIRE_EMAIL_VERIFICATION,
};
process.env.NODE_ENV = "production";
process.env.BETTER_AUTH_SECRET =
  "better-auth-rate-limit-test-secret-at-least-32-bytes";
process.env.BETTER_AUTH_RATE_LIMIT_ENABLED = "true";
process.env.AUTH_TRUST_PROXY = "true";
process.env.REQUIRE_EMAIL_VERIFICATION = "true";

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import crypto from "crypto";
import { eq } from "drizzle-orm";
import { Elysia } from "elysia";
import { db } from "../db";
import { rateLimit, users } from "../db/schema";

const { authRoutes } = await import("./index");
const app = new Elysia().use(authRoutes);
const createdEmails: string[] = [];

async function request(path: string, body: unknown, ip: string) {
  const response = await app.handle(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "rate-limit-test/1.0",
        "x-real-ip": ip,
        // This external name is deliberately ignored/overwritten by the
        // wrapper and cannot spoof Better Auth's internal trusted header.
        "x-thechat-client-ip": "203.0.113.250",
      },
      body: JSON.stringify(body),
    }),
  );
  return {
    status: response.status,
    retryAfter:
      response.headers.get("retry-after") ??
      response.headers.get("x-retry-after"),
  };
}

async function createLoginUser() {
  const email = `rate-${crypto.randomUUID()}@test.com`;
  createdEmails.push(email);
  const registered = await request(
    "/auth/register",
    { name: "Rate Limited", email, password: "password123" },
    "198.51.100.99",
  );
  expect(registered.status).toBe(200);
  await db.delete(rateLimit);
  return email;
}

beforeEach(async () => {
  process.env.AUTH_TRUST_PROXY = "true";
  await db.delete(rateLimit);
});

afterAll(async () => {
  await db.delete(rateLimit);
  for (const email of createdEmails) {
    await db.delete(users).where(eq(users.email, email));
  }
  if (previousEnv.nodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousEnv.nodeEnv;
  if (previousEnv.secret === undefined) delete process.env.BETTER_AUTH_SECRET;
  else process.env.BETTER_AUTH_SECRET = previousEnv.secret;
  if (previousEnv.enabled === undefined) {
    delete process.env.BETTER_AUTH_RATE_LIMIT_ENABLED;
  } else process.env.BETTER_AUTH_RATE_LIMIT_ENABLED = previousEnv.enabled;
  if (previousEnv.trustProxy === undefined) delete process.env.AUTH_TRUST_PROXY;
  else process.env.AUTH_TRUST_PROXY = previousEnv.trustProxy;
  if (previousEnv.requireEmailVerification === undefined) {
    delete process.env.REQUIRE_EMAIL_VERIFICATION;
  } else {
    process.env.REQUIRE_EMAIL_VERIFICATION =
      previousEnv.requireEmailVerification;
  }
});

describe("Better Auth shared rate limiting", () => {
  test("preserves the upstream 429 when verified registration delivery was not attempted", async () => {
    let last: Awaited<ReturnType<typeof request>> | null = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      const email = `rate-register-${crypto.randomUUID()}@test.com`;
      createdEmails.push(email);
      last = await request(
        "/auth/register",
        { name: "Rate Limited Registration", email, password: "password123" },
        "198.51.100.5",
      );
      if (attempt < 3) expect(last.status).toBe(200);
    }

    expect(last?.status).toBe(429);
    expect(Number(last?.retryAfter)).toBeGreaterThan(0);
  });

  test("isolates client-IP buckets and preserves wrapper 429 retry metadata", async () => {
    const email = await createLoginUser();
    const body = { email, password: "wrong-password" };

    for (let attempt = 0; attempt < 3; attempt++) {
      expect((await request("/auth/login", body, "198.51.100.10")).status).toBe(
        401,
      );
    }

    expect((await request("/auth/login", body, "198.51.100.11")).status).toBe(
      401,
    );

    const limited = await request("/auth/login", body, "198.51.100.10");
    expect(limited.status).toBe(429);
    expect(Number(limited.retryAfter)).toBeGreaterThan(0);
  });

  test("rate limits unknown-email login attempts through the same shared path", async () => {
    const body = {
      email: `unknown-login-${crypto.randomUUID()}@test.com`,
      password: "wrong-password",
    };

    for (let attempt = 0; attempt < 3; attempt++) {
      expect((await request("/auth/login", body, "198.51.100.12")).status).toBe(
        401,
      );
    }

    const limited = await request("/auth/login", body, "198.51.100.12");
    expect(limited.status).toBe(429);
    expect(Number(limited.retryAfter)).toBeGreaterThan(0);
  });

  test("applies the same resend limiter before verified, unverified, and unknown account branches", async () => {
    const verifiedEmail = await createLoginUser();
    await db
      .update(users)
      .set({ emailVerified: true })
      .where(eq(users.email, verifiedEmail));
    const unverifiedEmail = await createLoginUser();
    const unknownEmail = `unknown-${crypto.randomUUID()}@test.com`;

    const cases = [
      { email: verifiedEmail, ip: "198.51.100.30" },
      { email: unknownEmail, ip: "198.51.100.31" },
      { email: unverifiedEmail, ip: "198.51.100.32" },
    ];

    for (let attempt = 0; attempt < 3; attempt++) {
      for (const entry of cases) {
        expect(
          (
            await request(
              "/auth/resend-verification",
              { email: entry.email },
              entry.ip,
            )
          ).status,
        ).toBe(200);
      }
    }

    for (const entry of cases) {
      const limited = await request(
        "/auth/resend-verification",
        { email: entry.email },
        entry.ip,
      );
      expect(limited.status).toBe(429);
      expect(Number(limited.retryAfter)).toBeGreaterThan(0);
    }
  });

  test("applies the same OTP verification limiter before known and unknown account branches", async () => {
    const email = await createLoginUser();
    const body = { code: "000000" };
    let knownLimited: Awaited<ReturnType<typeof request>> | null = null;
    let unknownLimited: Awaited<ReturnType<typeof request>> | null = null;

    for (let attempt = 0; attempt < 4; attempt++) {
      knownLimited = await request(
        "/auth/verify-email",
        { ...body, email },
        "198.51.100.30",
      );
      unknownLimited = await request(
        "/auth/verify-email",
        { ...body, email: `unknown-${email}` },
        "198.51.100.31",
      );
      if (attempt < 3) {
        expect(knownLimited.status).toBe(400);
        expect(unknownLimited.status).toBe(400);
      }
    }

    expect(knownLimited?.status).toBe(429);
    expect(unknownLimited?.status).toBe(429);
    expect(Number(knownLimited?.retryAfter)).toBeGreaterThan(0);
    expect(Number(unknownLimited?.retryAfter)).toBeGreaterThan(0);
  });

  test("ignores proxy headers when trusted-proxy mode is disabled", async () => {
    const email = await createLoginUser();
    process.env.AUTH_TRUST_PROXY = "false";
    const body = { email, password: "wrong-password" };

    for (let attempt = 0; attempt < 3; attempt++) {
      expect(
        (await request("/auth/login", body, `198.51.100.${attempt + 20}`))
          .status,
      ).toBe(401);
    }

    // app.handle has no network peer; all untrusted header values therefore
    // share Better Auth's no-trusted-IP bucket instead of selecting a bucket.
    expect((await request("/auth/login", body, "203.0.113.77")).status).toBe(
      429,
    );
  });
});
