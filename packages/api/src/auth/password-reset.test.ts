import {
  afterAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import crypto from "crypto";
import { desc, eq } from "drizzle-orm";
import { Elysia } from "elysia";
import { assertDisposablePasswordResetTestEnvironment } from "../test-safety";

assertDisposablePasswordResetTestEnvironment();

const [{ db }, schema, betterAuthModule, resetModule, emailModule] =
  await Promise.all([
    import("../db"),
    import("../db/schema"),
    import("./better-auth"),
    import("./password-reset"),
    import("./email"),
  ]);
const { account, session, users, verification } = schema;
const {
  __setPasswordResetCodeSenderForTests,
  hashAuthenticationOtp,
} = betterAuthModule;
const { __setAtomicPasswordResetHookForTests } = resetModule;
const { buildPasswordResetCodeEmail } = emailModule;
const { authRoutes } = await import("./index");

const app = new Elysia().use(authRoutes);
const createdEmails = new Set<string>();
const deliveredCodes = new Map<string, string>();
const genericRequestMessage =
  "If an account exists for that email, a password reset code will be sent.";
const invalidCodeMessage = "Invalid or expired password reset code";
const originalOtpPepper = process.env.BETTER_AUTH_OTP_PEPPER;

type ApiResponse = {
  response: Response;
  body: Record<string, unknown>;
};

async function request(path: string, body: unknown): Promise<ApiResponse> {
  const response = await app.handle(
    new Request(`http://localhost/auth${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "password-reset-test/1.0",
      },
      body: JSON.stringify(body),
    }),
  );
  return {
    response,
    body: (await response.json()) as Record<string, unknown>,
  };
}

async function requestReset(email: string) {
  const startedAt = performance.now();
  const result = await request("/request-password-reset", { email });
  return { ...result, durationMs: performance.now() - startedAt };
}

async function resetPassword(email: string, code: string, password: string) {
  const startedAt = performance.now();
  const result = await request("/reset-password", { email, code, password });
  return { ...result, durationMs: performance.now() - startedAt };
}

async function register(email: string, password = "old-password-123") {
  createdEmails.add(email);
  const result = await request("/register", {
    name: "Password Reset Test",
    email,
    password,
  });
  expect(result.response.status).toBe(200);
  const token = responseToken(result);
  expect(token).toBeTruthy();
  return token!;
}

async function login(email: string, password: string) {
  return request("/login", { email, password });
}

function responseToken(result: ApiResponse) {
  const body = result.body as {
    accessToken?: unknown;
    token?: unknown;
    session?: { token?: unknown };
    sessionToken?: unknown;
  };
  const token =
    result.response.headers.get("set-auth-token") ??
    body.accessToken ??
    body.token ??
    body.session?.token ??
    body.sessionToken;
  return typeof token === "string" ? token : null;
}

async function me(token: string) {
  const response = await app.handle(
    new Request("http://localhost/auth/me", {
      headers: { authorization: `Bearer ${token}` },
    }),
  );
  return {
    response,
    body: (await response.json()) as Record<string, unknown>,
  };
}

function resetIdentifier(email: string) {
  return `forget-password-otp-${email}`;
}

async function latestResetVerification(email: string) {
  const [row] = await db
    .select()
    .from(verification)
    .where(eq(verification.identifier, resetIdentifier(email)))
    .orderBy(desc(verification.createdAt), desc(verification.id))
    .limit(1);
  return row;
}

function storedHashAndAttempts(value: string) {
  const separator = value.lastIndexOf(":");
  return {
    hash: value.slice(0, separator),
    attempts: Number(value.slice(separator + 1)),
  };
}

function wrongCodeFor(code: string) {
  return code === "000000" ? "000001" : "000000";
}

beforeEach(() => {
  deliveredCodes.clear();
  __setAtomicPasswordResetHookForTests(null);
  __setPasswordResetCodeSenderForTests(async (email, code) => {
    deliveredCodes.set(email, code);
  });
});

afterAll(async () => {
  __setPasswordResetCodeSenderForTests(null);
  __setAtomicPasswordResetHookForTests(null);
  if (originalOtpPepper === undefined) {
    delete process.env.BETTER_AUTH_OTP_PEPPER;
  } else {
    process.env.BETTER_AUTH_OTP_PEPPER = originalOtpPepper;
  }
  for (const email of createdEmails) {
    await db
      .delete(verification)
      .where(eq(verification.identifier, resetIdentifier(email)));
    await db.delete(users).where(eq(users.email, email));
  }
});

describe("password reset request", () => {
  test("uses a generic response and stores a keyed, expiring OTP", async () => {
    const email = `reset-${crypto.randomUUID()}@example.invalid`;
    const unknownEmail = `unknown-${crypto.randomUUID()}@example.invalid`;
    await register(email);

    const known = await requestReset(email);
    const unknown = await requestReset(unknownEmail);

    expect(known.response.status).toBe(200);
    expect(unknown.response.status).toBe(200);
    expect(known.body).toEqual({ message: genericRequestMessage });
    expect(unknown.body).toEqual({ message: genericRequestMessage });
    expect(known.durationMs).toBeGreaterThanOrEqual(295);
    expect(unknown.durationMs).toBeGreaterThanOrEqual(295);
    expect(Math.abs(known.durationMs - unknown.durationMs)).toBeLessThan(160);
    expect(deliveredCodes.has(email)).toBe(true);
    expect(deliveredCodes.has(unknownEmail)).toBe(false);

    const code = deliveredCodes.get(email)!;
    expect(code).toMatch(/^\d{6}$/);
    const row = await latestResetVerification(email);
    expect(row).toBeTruthy();
    const stored = storedHashAndAttempts(row!.value);
    expect(stored.attempts).toBe(0);
    expect(stored.hash).toBe(await hashAuthenticationOtp(code));
    expect(stored.hash).not.toBe(
      crypto.createHash("sha256").update(code).digest("base64url"),
    );
    expect(stored.hash).not.toBe(
      crypto.createHash("sha256").update(code).digest("hex"),
    );
    expect(row!.expiresAt.getTime()).toBeGreaterThan(Date.now() + 14 * 60_000);
    expect(row!.expiresAt.getTime()).toBeLessThan(Date.now() + 16 * 60_000);
  });

  test("makes OTP hashes reproducible only with the same pepper", async () => {
    try {
      process.env.BETTER_AUTH_OTP_PEPPER = "a".repeat(32);
      const first = await hashAuthenticationOtp("123456");
      const repeated = await hashAuthenticationOtp("123456");
      process.env.BETTER_AUTH_OTP_PEPPER = "b".repeat(32);
      const changed = await hashAuthenticationOtp("123456");

      expect(first).toBe(repeated);
      expect(changed).not.toBe(first);
      expect(first).not.toBe(
        crypto.createHash("sha256").update("123456").digest("hex"),
      );
    } finally {
      if (originalOtpPepper === undefined) {
        delete process.env.BETTER_AUTH_OTP_PEPPER;
      } else {
        process.env.BETTER_AUTH_OTP_PEPPER = originalOtpPepper;
      }
    }
  });

  test("does not expose provider failure or provider latency", async () => {
    const failingEmail = `provider-fail-${crypto.randomUUID()}@example.invalid`;
    const blockedEmail = `provider-blocked-${crypto.randomUUID()}@example.invalid`;
    await register(failingEmail);
    await register(blockedEmail);

    __setPasswordResetCodeSenderForTests(async () => {
      throw new Error("simulated provider failure containing no real address");
    });
    const failed = await requestReset(failingEmail);
    expect(failed.response.status).toBe(200);
    expect(failed.body).toEqual({ message: genericRequestMessage });

    __setPasswordResetCodeSenderForTests(
      () => new Promise<void>(() => undefined),
    );
    const blocked = await requestReset(blockedEmail);
    expect(blocked.response.status).toBe(200);
    expect(blocked.body).toEqual({ message: genericRequestMessage });
    expect(blocked.durationMs).toBeLessThan(1_000);
  });
});

describe("password reset confirmation", () => {
  test("changes the password, consumes the OTP, and revokes all sessions", async () => {
    const email = `complete-${crypto.randomUUID()}@example.invalid`;
    const oldPassword = "old-password-123";
    const newPassword = "new-password-456";
    const originalToken = await register(email, oldPassword);
    const secondLogin = await login(email, oldPassword);
    expect(secondLogin.response.status).toBe(200);
    const secondToken = responseToken(secondLogin)!;
    expect(secondToken).toBeTruthy();

    await requestReset(email);
    const code = deliveredCodes.get(email)!;
    const reset = await resetPassword(email, code, newPassword);

    expect(reset.response.status).toBe(200);
    expect(reset.body).toEqual({
      message: "Password reset. You can now log in with your new password.",
    });
    expect((await login(email, oldPassword)).response.status).toBe(401);
    expect((await login(email, newPassword)).response.status).toBe(200);
    expect((await me(originalToken)).response.status).toBe(401);
    expect((await me(secondToken)).response.status).toBe(401);
    expect(await latestResetVerification(email)).toBeUndefined();
  });

  test("rejects expired codes and enforces exactly five wrong attempts", async () => {
    const email = `attempts-${crypto.randomUUID()}@example.invalid`;
    await register(email);

    await requestReset(email);
    const expiredCode = deliveredCodes.get(email)!;
    await db
      .update(verification)
      .set({ expiresAt: new Date(Date.now() - 1) })
      .where(eq(verification.identifier, resetIdentifier(email)));
    const expired = await resetPassword(
      email,
      expiredCode,
      "new-password-456",
    );
    expect(expired.response.status).toBe(400);
    expect(expired.body).toEqual({ error: invalidCodeMessage });
    expect(await latestResetVerification(email)).toBeUndefined();

    await requestReset(email);
    const validCode = deliveredCodes.get(email)!;
    const wrongCode = wrongCodeFor(validCode);
    for (let attempt = 1; attempt <= 5; attempt++) {
      const wrong = await resetPassword(
        email,
        wrongCode,
        "new-password-456",
      );
      expect(wrong.response.status).toBe(400);
      expect(wrong.body).toEqual({ error: invalidCodeMessage });
      const row = await latestResetVerification(email);
      expect(storedHashAndAttempts(row!.value).attempts).toBe(attempt);
    }

    const exhausted = await resetPassword(
      email,
      validCode,
      "new-password-456",
    );
    expect(exhausted.response.status).toBe(400);
    expect(exhausted.body).toEqual({ error: invalidCodeMessage });
    expect(await latestResetVerification(email)).toBeUndefined();
    expect((await login(email, "old-password-123")).response.status).toBe(200);
  });

  test("rotates reset codes and rejects the older code", async () => {
    const email = `rotate-${crypto.randomUUID()}@example.invalid`;
    await register(email);

    await requestReset(email);
    const firstCode = deliveredCodes.get(email)!;
    await requestReset(email);
    const secondCode = deliveredCodes.get(email)!;
    expect(secondCode).not.toBe(firstCode);

    const oldCodeResult = await resetPassword(
      email,
      firstCode,
      "new-password-456",
    );
    expect(oldCodeResult.response.status).toBe(400);
    const latestResult = await resetPassword(
      email,
      secondCode,
      "new-password-456",
    );
    expect(latestResult.response.status).toBe(200);
    expect(await latestResetVerification(email)).toBeUndefined();
  });

  test("allows only one concurrent reset to consume a code", async () => {
    const email = `concurrent-${crypto.randomUUID()}@example.invalid`;
    await register(email);
    await requestReset(email);
    const code = deliveredCodes.get(email)!;

    const results = await Promise.all([
      resetPassword(email, code, "concurrent-password-a"),
      resetPassword(email, code, "concurrent-password-b"),
    ]);
    expect(results.map((result) => result.response.status).sort()).toEqual([
      200, 400,
    ]);
    const winningPassword =
      results[0]!.response.status === 200
        ? "concurrent-password-a"
        : "concurrent-password-b";
    const losingPassword =
      winningPassword === "concurrent-password-a"
        ? "concurrent-password-b"
        : "concurrent-password-a";
    expect((await login(email, winningPassword)).response.status).toBe(200);
    expect((await login(email, losingPassword)).response.status).toBe(401);
  });

  test("rolls back password mutation, session revocation, and OTP consumption together", async () => {
    const email = `rollback-${crypto.randomUUID()}@example.invalid`;
    const token = await register(email);
    await requestReset(email);
    const code = deliveredCodes.get(email)!;

    __setAtomicPasswordResetHookForTests(() => {
      throw new Error("simulated session revocation failure");
    });
    const failed = await resetPassword(email, code, "new-password-456");
    __setAtomicPasswordResetHookForTests(null);

    expect(failed.response.status).toBe(503);
    expect(failed.body).toEqual({
      error: "Authentication service temporarily unavailable",
    });
    expect((await me(token)).response.status).toBe(200);
    expect((await login(email, "old-password-123")).response.status).toBe(200);
    expect((await login(email, "new-password-456")).response.status).toBe(401);
    expect(await latestResetVerification(email)).toBeTruthy();

    const retry = await resetPassword(email, code, "new-password-456");
    expect(retry.response.status).toBe(200);
    expect((await me(token)).response.status).toBe(401);
  });

  test("equalizes known-human, unknown, and bot failure envelopes", async () => {
    const humanEmail = `timing-human-${crypto.randomUUID()}@example.invalid`;
    const unknownEmail = `timing-unknown-${crypto.randomUUID()}@example.invalid`;
    const botEmail = `timing-bot-${crypto.randomUUID()}@example.invalid`;
    await register(humanEmail);
    createdEmails.add(botEmail);
    await db.insert(users).values({
      name: "Timing Bot",
      email: botEmail,
      type: "bot",
      emailVerified: true,
    });
    await requestReset(humanEmail);
    const validCode = deliveredCodes.get(humanEmail)!;

    const cases = [
      { email: unknownEmail, code: "000000" },
      { email: humanEmail, code: wrongCodeFor(validCode) },
      { email: botEmail, code: "000000" },
    ];
    const results = [];
    for (const entry of cases) {
      results.push(
        await resetPassword(entry.email, entry.code, "new-password-456"),
      );
    }

    for (const result of results) {
      expect(result.response.status).toBe(400);
      expect(result.body).toEqual({ error: invalidCodeMessage });
      expect(result.durationMs).toBeGreaterThanOrEqual(445);
    }
    const durations = results.map((result) => result.durationMs);
    expect(Math.max(...durations) - Math.min(...durations)).toBeLessThan(250);
  });
});

describe("password reset email", () => {
  test("escapes interpolated values in the reset template", () => {
    const message = buildPasswordResetCodeEmail(
      "123456<script>alert(1)</script>",
    );
    expect(message.subject).toBe("Your TheChat password reset code");
    expect(message.text).toContain("123456<script>alert(1)</script>");
    expect(message.html).toContain("123456&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(message.html).not.toContain("<script>alert(1)</script>");
  });
});
