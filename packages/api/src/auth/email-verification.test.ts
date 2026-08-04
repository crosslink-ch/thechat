// Enable email verification behavior for this file only.
const previousRequireEmailVerification = process.env.REQUIRE_EMAIL_VERIFICATION;
process.env.REQUIRE_EMAIL_VERIFICATION = "true";

import { describe, test, expect, afterAll } from "bun:test";
import { Elysia } from "elysia";
import { desc, eq, like } from "drizzle-orm";
import { db } from "../db";
import {
  users,
  verification,
  session as betterAuthSession,
} from "../db/schema";
import crypto from "crypto";

const { authRoutes } = await import("./index");
const { __setVerificationCodeSenderForTests } = await import("./better-auth");
const app = new Elysia().use(authRoutes);
const deliveredOtps = new Map<string, string>();
const captureOtp = async (email: string, otp: string) => {
  deliveredOtps.set(email, otp);
};
__setVerificationCodeSenderForTests(captureOtp);

function uniqueEmail() {
  return `test-${crypto.randomUUID()}@test.com`;
}

const createdUserEmails: string[] = [];

async function cleanup() {
  for (const email of createdUserEmails) {
    await db
      .delete(verification)
      .where(like(verification.identifier, `%${email}%`));

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
  __setVerificationCodeSenderForTests(null);
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
  token?: string,
) {
  const headers: Record<string, string> = {};
  if (body) headers["Content-Type"] = "application/json";
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const response = await app.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    }),
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

async function fetchVerificationForEmail(email: string) {
  const [row] = await db
    .select()
    .from(verification)
    .where(like(verification.identifier, `%${email}%`))
    .orderBy(desc(verification.createdAt))
    .limit(1);
  return row ?? null;
}

async function fetchOtpForEmail(email: string): Promise<string> {
  const otp = deliveredOtps.get(email);
  if (!otp) throw new Error(`no delivered verification code for ${email}`);
  return otp;
}

async function getUserState(email: string) {
  const [user] = await db
    .select({
      id: users.id,
      emailVerified: users.emailVerified,
    })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (!user) throw new Error(`no user for ${email}`);
  return user;
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

  test("does not leave a sign-up session while email is unverified", async () => {
    const email = uniqueEmail();
    await registerUser(email);

    const user = await getUserState(email);
    const sessions = await db
      .select({ id: betterAuthSession.id })
      .from(betterAuthSession)
      .where(eq(betterAuthSession.userId, user.id));

    expect(sessions).toHaveLength(0);
  });

  test("does not expose native Better Auth routes as an unverified-user bypass", async () => {
    const email = uniqueEmail();
    await registerUser(email);

    const publicPrefix = await req("POST", "/auth/sign-in/email", {
      email,
      password: "password123",
    });
    const internalPrefix = await req("POST", "/_better-auth/sign-in/email", {
      email,
      password: "password123",
    });

    expect(publicPrefix.status).not.toBe(200);
    expect(internalPrefix.status).not.toBe(200);
  });

  test("delivers a 6-digit code but stores only its hash with a future expiry", async () => {
    const email = uniqueEmail();
    await registerUser(email);

    const row = await fetchVerificationForEmail(email);
    const deliveredOtp = await fetchOtpForEmail(email);
    expect(row).toBeDefined();
    expect(deliveredOtp).toMatch(/^\d{6}$/);
    expect(row!.value).not.toContain(deliveredOtp);
    expect(row!.value).toEndWith(":0");
    expect(row!.expiresAt.getTime()).toBeGreaterThan(Date.now());

    const ttlMs = row!.expiresAt.getTime() - Date.now();
    expect(ttlMs).toBeGreaterThan(14 * 60 * 1000);
    expect(ttlMs).toBeLessThanOrEqual(15 * 60 * 1000 + 5000);
  });

  test("keeps registration recoverable when initial email delivery fails", async () => {
    const email = uniqueEmail();
    createdUserEmails.push(email);
    __setVerificationCodeSenderForTests(async () => {
      throw new Error("mail provider unavailable");
    });

    try {
      const res = await req("POST", "/auth/register", {
        name: "Delivery Pending",
        email,
        password: "password123",
      });
      expect(res.status).toBe(200);
      expect(res.body.message).toContain("Account created");
      expect(res.body.message).toContain("Send a new code");
      expect(res.body.accessToken).toBeUndefined();

      const [row] = await db
        .select({
          id: users.id,
        })
        .from(users)
        .where(eq(users.email, email))
        .limit(1);
      expect(row.id).toBeTruthy();
      expect(
        await db
          .select({ id: betterAuthSession.id })
          .from(betterAuthSession)
          .where(eq(betterAuthSession.userId, row.id)),
      ).toHaveLength(0);
    } finally {
      __setVerificationCodeSenderForTests(captureOtp);
    }
  });

  test("the email body for an unrelated request never contains a clickable URL", async () => {
    const { sendVerificationCode } = await import("./email");
    let capturedHtml = "";
    const original = (globalThis as any).fetch;
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
    expect(capturedHtml).not.toMatch(/<a\s/i);
    expect(capturedHtml).not.toMatch(/href\s*=/i);
    expect(capturedHtml).not.toContain("verify-email");
  });
});

describe("Email Verification: Login blocked until verified", () => {
  test("does not reveal an unverified account before the password is accepted", async () => {
    const email = uniqueEmail();
    await registerUser(email);

    const res = await req("POST", "/auth/login", {
      email,
      password: "wrong-password",
    });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Invalid email or password");
  });

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

describe("Email Verification: POST /verify-email", () => {
  test("correct code verifies the user, consumes the row, and returns a session token", async () => {
    const email = uniqueEmail();
    await registerUser(email);
    const code = await fetchOtpForEmail(email);

    const res = await req("POST", "/auth/verify-email", { email, code });

    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.refreshToken).toBeUndefined();
    expect(res.body.user?.email).toBe(email);

    const updated = await getUserState(email);
    expect(updated.emailVerified).toBe(true);

    const gone = await fetchVerificationForEmail(email);
    expect(gone).toBeNull();

    const meRes = await req("GET", "/auth/me", undefined, res.body.accessToken);
    expect(meRes.status).toBe(200);
    expect(meRes.body.user?.email).toBe(email);

    const logoutRes = await req(
      "POST",
      "/auth/logout",
      {},
      res.body.accessToken,
    );
    expect(logoutRes.status).toBe(200);

    const afterLogout = await req(
      "GET",
      "/auth/me",
      undefined,
      res.body.accessToken,
    );
    expect(afterLogout.status).toBe(401);
  });

  test("after successful verify, the user can log in normally", async () => {
    const email = uniqueEmail();
    await registerUser(email);
    const code = await fetchOtpForEmail(email);
    await req("POST", "/auth/verify-email", { email, code });

    const res = await req("POST", "/auth/login", {
      email,
      password: "password123",
    });

    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
  });

  test("wrong code returns 400 and leaves the user unverified", async () => {
    const email = uniqueEmail();
    await registerUser(email);
    const realCode = await fetchOtpForEmail(email);
    const wrongCode = realCode === "000000" ? "111111" : "000000";

    const res = await req("POST", "/auth/verify-email", {
      email,
      code: wrongCode,
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Invalid or expired");

    const stillUnverified = await getUserState(email);
    expect(stillUnverified.emailVerified).toBe(false);
  });

  test("after 5 wrong attempts, even the correct code fails", async () => {
    const email = uniqueEmail();
    await registerUser(email);
    const realCode = await fetchOtpForEmail(email);
    const wrongCode = realCode === "000000" ? "111111" : "000000";

    for (let i = 0; i < 5; i++) {
      const res = await req("POST", "/auth/verify-email", {
        email,
        code: wrongCode,
      });
      expect(res.status).toBe(400);
    }

    const burned = await req("POST", "/auth/verify-email", {
      email,
      code: realCode,
    });
    expect(burned.status).toBe(400);
    expect(burned.body.error).toContain("Too many");
    expect(await fetchVerificationForEmail(email)).toBeNull();

    const stillUnverified = await getUserState(email);
    expect(stillUnverified.emailVerified).toBe(false);
  });

  test("expired code returns 400", async () => {
    const email = uniqueEmail();
    await registerUser(email);
    const code = await fetchOtpForEmail(email);
    const row = await fetchVerificationForEmail(email);

    await db
      .update(verification)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(verification.id, row!.id));

    const res = await req("POST", "/auth/verify-email", { email, code });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Invalid or expired");

    const stillUnverified = await getUserState(email);
    expect(stillUnverified.emailVerified).toBe(false);
  });

  test("malformed code returns 400 with a validation message", async () => {
    const email = uniqueEmail();
    await registerUser(email);

    const cases = ["12345", "1234567", "abcdef", "12 345", ""];
    for (const code of cases) {
      const res = await req("POST", "/auth/verify-email", { email, code });
      expect(res.status).toBe(400);
    }
  });

  test("verifying with a code that belongs to a different user fails", async () => {
    const aliceEmail = uniqueEmail();
    const bobEmail = uniqueEmail();
    await registerUser(aliceEmail);
    await registerUser(bobEmail);

    const aliceCode = await fetchOtpForEmail(aliceEmail);

    const res = await req("POST", "/auth/verify-email", {
      email: bobEmail,
      code: aliceCode,
    });
    expect(res.status).toBe(400);

    const bob = await getUserState(bobEmail);
    expect(bob.emailVerified).toBe(false);

    const aliceVerify = await req("POST", "/auth/verify-email", {
      email: aliceEmail,
      code: aliceCode,
    });
    expect(aliceVerify.status).toBe(200);
  });

  test("a verified account cannot redeem a leftover verification code for a new session", async () => {
    const email = uniqueEmail();
    await registerUser(email);
    const code = await fetchOtpForEmail(email);
    const user = await getUserState(email);

    // Simulate an account verified by another flow while an older OTP row is
    // still present. The public wrapper must not turn that OTP into a session.
    await db
      .update(users)
      .set({ emailVerified: true })
      .where(eq(users.id, user.id));

    const res = await req("POST", "/auth/verify-email", { email, code });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Invalid or expired");
    expect(res.body.accessToken).toBeUndefined();

    const sessions = await db
      .select({ id: betterAuthSession.id })
      .from(betterAuthSession)
      .where(eq(betterAuthSession.userId, user.id));
    expect(sessions).toHaveLength(0);
  });

  test("nonexistent email returns the same generic error", async () => {
    const res = await req("POST", "/auth/verify-email", {
      email: uniqueEmail(),
      code: "123456",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Invalid or expired");
  });
});

describe("Email Verification: Resend", () => {
  test("returns consistent message and creates a fresh code", async () => {
    const email = uniqueEmail();
    await registerUser(email);
    const firstCode = await fetchOtpForEmail(email);

    const res = await req("POST", "/auth/resend-verification", { email });
    expect(res.status).toBe(200);
    expect(res.body.message).toBeDefined();

    const row = await fetchVerificationForEmail(email);
    expect(row).toBeDefined();
    const nextCode = await fetchOtpForEmail(email);
    expect(nextCode).toMatch(/^\d{6}$/);
    expect(nextCode).not.toBe(firstCode);
  });

  test("keeps the public resend response generic when delivery fails", async () => {
    const email = uniqueEmail();
    await registerUser(email);
    __setVerificationCodeSenderForTests(async () => {
      throw new Error("mail provider unavailable");
    });

    try {
      const res = await req("POST", "/auth/resend-verification", { email });
      expect(res.status).toBe(200);
      expect(res.body.message).toBe(
        "If that email is registered and unverified, a delivery attempt will be made.",
      );
    } finally {
      __setVerificationCodeSenderForTests(captureOtp);
    }
  });

  test("resending invalidates the old code", async () => {
    const email = uniqueEmail();
    await registerUser(email);
    const oldCode = await fetchOtpForEmail(email);

    await req("POST", "/auth/resend-verification", { email });

    const res = await req("POST", "/auth/verify-email", {
      email,
      code: oldCode,
    });
    expect(res.status).toBe(400);
  });

  test("resending resets the Better Auth attempt budget", async () => {
    const email = uniqueEmail();
    await registerUser(email);
    const originalCode = await fetchOtpForEmail(email);
    const wrongCode = originalCode === "000000" ? "111111" : "000000";

    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await req("POST", "/auth/verify-email", {
        email,
        code: wrongCode,
      });
      expect(res.status).toBe(400);
    }

    expect((await fetchVerificationForEmail(email))?.value).toEndWith(":3");

    await req("POST", "/auth/resend-verification", { email });
    const next = await fetchVerificationForEmail(email);
    expect(next?.value).toEndWith(":0");

    const verify = await req("POST", "/auth/verify-email", {
      email,
      code: await fetchOtpForEmail(email),
    });
    expect(verify.status).toBe(200);
  });

  test("returns same message for nonexistent email", async () => {
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
    await req("POST", "/auth/verify-email", { email, code });
    deliveredOtps.delete(email);

    const res = await req("POST", "/auth/resend-verification", { email });

    expect(res.status).toBe(200);
    expect(res.body.message).toBeDefined();

    const row = await fetchVerificationForEmail(email);
    expect(row).toBeNull();
    expect(deliveredOtps.has(email)).toBe(false);
  });
});
