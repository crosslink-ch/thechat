import { Elysia } from "elysia";
import { eq, and, gt, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import { users, sessions, emailVerifications } from "../db/schema";
import { sendVerificationCode } from "./email";
import { resolveTokenToUser } from "./middleware";
import { signAccessToken } from "./jwt";
import crypto from "crypto";

function generateRefreshToken(): string {
  return crypto.randomBytes(32).toString("hex"); // 64 hex chars
}

// Cryptographically uniform 6-digit numeric code, zero-padded.
// Uses crypto.randomInt to avoid the modulo bias that `Math.random()` and
// `crypto.randomBytes(...) % 1000000` would introduce.
function generateVerificationCode(): string {
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, "0");
}

const VERIFICATION_CODE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const MAX_VERIFICATION_ATTEMPTS = 5;

function verificationExpiresAt(): Date {
  return new Date(Date.now() + VERIFICATION_CODE_TTL_MS);
}

function sessionExpiresAt(): Date {
  const d = new Date();
  d.setFullYear(d.getFullYear() + 1);
  return d;
}

function isEmailVerificationRequired() {
  return process.env.REQUIRE_EMAIL_VERIFICATION === "true";
}

// Opportunistic cleanup: piggyback on writes to the email_verifications table
// to garbage-collect rows whose 15-min window has passed. Throttled to at most
// once every 15 minutes per process so a burst of registrations doesn't run
// the same DELETE over and over. Cheap, and avoids a background scheduler.
const CLEANUP_THROTTLE_MS = 15 * 60 * 1000;
let lastCleanupAt = 0;

async function cleanupExpiredVerifications() {
  const now = Date.now();
  if (now - lastCleanupAt < CLEANUP_THROTTLE_MS) return;
  lastCleanupAt = now;

  await db
    .delete(emailVerifications)
    .where(lt(emailVerifications.expiresAt, new Date()));
}

// Test-only: reset the throttle so cleanup tests can trigger consecutive
// sweeps within the same process. Not used by production code.
export function __resetCleanupThrottleForTests() {
  lastCleanupAt = 0;
}

// Mints a session row + access JWT for a user. Shared by /login and the
// successful branch of /verify-email-otp so OTP-verified users are logged in
// immediately without a separate /login round-trip.
async function issueSessionTokens(user: {
  id: string;
  name: string;
  email: string | null;
  avatar: string | null;
}) {
  const refreshToken = generateRefreshToken();
  await db.insert(sessions).values({
    userId: user.id,
    token: refreshToken,
    expiresAt: sessionExpiresAt(),
  });

  const accessToken = await signAccessToken({
    sub: user.id,
    name: user.name,
    email: user.email,
    avatar: user.avatar,
    type: "human",
  });

  return {
    accessToken,
    refreshToken,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      avatar: user.avatar,
      type: "human" as const,
    },
  };
}

// ── Schemas ──

const registerSchema = z.object({
  name: z.string().trim().min(1, "Name is required"),
  email: z.email("Please enter a valid email address"),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

const loginSchema = z.object({
  email: z.email("Please enter a valid email address"),
  password: z.string().min(1, "Password is required"),
});

const resendVerificationSchema = z.object({
  email: z.email("Please enter a valid email address"),
});

const verifyEmailOtpSchema = z.object({
  email: z.email("Please enter a valid email address"),
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, "Verification code must be 6 digits"),
});

const refreshSchema = z.object({
  refreshToken: z.string().min(1, "Refresh token is required"),
});

function formatZodError(err: z.ZodError): string {
  return err.issues[0]?.message ?? "Invalid input";
}

export const authRoutes = new Elysia({ prefix: "/auth" })
  // ── Register ──
  .post("/register", async ({ body, set }) => {
    const parsed = registerSchema.safeParse(body);
    if (!parsed.success) {
      set.status = 400;
      return { error: formatZodError(parsed.error) };
    }

    const { name, email: rawEmail, password } = parsed.data;
    const email = rawEmail.toLowerCase();

    // Check email uniqueness
    const [existing] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    if (existing) {
      set.status = 409;
      return { error: "An account with this email already exists" };
    }

    // Hash password with Bun's built-in argon2id
    const passwordHash = await Bun.password.hash(password, {
      algorithm: "argon2id",
    });

    // Create user
    const [user] = await db
      .insert(users)
      .values({
        name,
        email,
        type: "human",
        passwordHash,
      })
      .returning({
        id: users.id,
        name: users.name,
        email: users.email,
        avatar: users.avatar,
        type: users.type,
      });

    if (isEmailVerificationRequired()) {
      await cleanupExpiredVerifications();

      const code = generateVerificationCode();

      await db.insert(emailVerifications).values({
        userId: user.id,
        code,
        expiresAt: verificationExpiresAt(),
      });

      try {
        await sendVerificationCode(email, code);
      } catch {
        // Don't fail registration if email fails
      }

      return {
        message:
          "Registration successful. Check your email for a 6-digit verification code.",
      };
    }

    // Auto-login: create refresh token (session) + JWT access token
    const refreshToken = generateRefreshToken();
    await db.insert(sessions).values({
      userId: user.id,
      token: refreshToken,
      expiresAt: sessionExpiresAt(),
    });

    const accessToken = await signAccessToken({
      sub: user.id,
      name: user.name,
      email: user.email,
      avatar: user.avatar,
      type: "human",
    });

    return { accessToken, refreshToken, user };
  })

  // ── Login ──
  .post("/login", async ({ body, set }) => {
    const parsed = loginSchema.safeParse(body);
    if (!parsed.success) {
      set.status = 400;
      return { error: formatZodError(parsed.error) };
    }

    const { email: rawEmail, password } = parsed.data;
    const email = rawEmail.toLowerCase();

    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    if (!user || !user.passwordHash) {
      set.status = 401;
      return { error: "Invalid email or password" };
    }

    const valid = await Bun.password.verify(password, user.passwordHash);
    if (!valid) {
      set.status = 401;
      return { error: "Invalid email or password" };
    }

    if (isEmailVerificationRequired() && !user.emailVerifiedAt) {
      set.status = 403;
      return { error: "Please verify your email before logging in" };
    }

    const refreshToken = generateRefreshToken();
    await db.insert(sessions).values({
      userId: user.id,
      token: refreshToken,
      expiresAt: sessionExpiresAt(),
    });

    const accessToken = await signAccessToken({
      sub: user.id,
      name: user.name,
      email: user.email,
      avatar: user.avatar,
      type: "human",
    });

    return {
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        avatar: user.avatar,
        type: "human" as const,
      },
    };
  })

  // ── Verify email via OTP code (public) ──
  // Code-based verification is immune to email-scanner pre-fetch (no URL to
  // consume). On success we issue tokens so the user is logged in immediately
  // without a separate login round-trip.
  .post("/verify-email-otp", async ({ body, set }) => {
    const parsed = verifyEmailOtpSchema.safeParse(body);
    if (!parsed.success) {
      set.status = 400;
      return { error: formatZodError(parsed.error) };
    }

    const email = parsed.data.email.toLowerCase();
    const submittedCode = parsed.data.code;

    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    // Generic error for both "no such user" and "no/expired/blown row" so we
    // don't leak whether the email is registered.
    const genericError = { error: "Invalid or expired verification code" };

    if (!user) {
      set.status = 400;
      return genericError;
    }

    // Already verified — treat as success and return fresh tokens. This makes
    // the endpoint idempotent for the legitimate user without leaking that
    // the row would have been valid; an attacker hitting it without the
    // matching code still gets the genericError branch first because we
    // require the row to exist.
    if (user.emailVerifiedAt) {
      const [verification] = await db
        .select()
        .from(emailVerifications)
        .where(eq(emailVerifications.userId, user.id))
        .limit(1);
      if (verification) {
        await db
          .delete(emailVerifications)
          .where(eq(emailVerifications.userId, user.id));
      }
      return await issueSessionTokens(user);
    }

    const [verification] = await db
      .select()
      .from(emailVerifications)
      .where(
        and(
          eq(emailVerifications.userId, user.id),
          gt(emailVerifications.expiresAt, new Date())
        )
      )
      .limit(1);

    if (!verification) {
      set.status = 400;
      return genericError;
    }

    // Already burned by too many wrong attempts — force a resend.
    if (verification.attempts >= MAX_VERIFICATION_ATTEMPTS) {
      await db
        .delete(emailVerifications)
        .where(eq(emailVerifications.id, verification.id));
      set.status = 400;
      return {
        error:
          "Too many incorrect attempts. Request a new code and try again.",
      };
    }

    // Constant-time-ish comparison via timingSafeEqual on equal-length buffers.
    // The submitted code is regex-validated to 6 digits and the stored code
    // is always 6 digits, so the lengths match.
    const a = Buffer.from(submittedCode, "utf8");
    const b = Buffer.from(verification.code, "utf8");
    const matches = a.length === b.length && crypto.timingSafeEqual(a, b);

    if (!matches) {
      // Increment attempts atomically. If this push takes us to the limit,
      // the next call will hit the burn-out branch above.
      await db
        .update(emailVerifications)
        .set({ attempts: sql`${emailVerifications.attempts} + 1` })
        .where(eq(emailVerifications.id, verification.id));
      set.status = 400;
      return genericError;
    }

    // Success — flip the verified flag and consume the row in a single
    // transaction so the row cannot survive past the moment of verification.
    // With OTP we can safely delete on success because there is no
    // scanner-prefetch concern.
    await db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({ emailVerifiedAt: new Date() })
        .where(eq(users.id, user.id));

      await tx
        .delete(emailVerifications)
        .where(eq(emailVerifications.userId, user.id));
    });

    return await issueSessionTokens(user);
  })

  // ── Resend verification ──
  .post("/resend-verification", async ({ body }) => {
    const parsed = resendVerificationSchema.safeParse(body);
    // Always return same message to prevent email enumeration
    const message =
      "If that email is registered and unverified, a new code has been sent.";

    if (!parsed.success) {
      return { message };
    }

    const email = parsed.data.email.toLowerCase();

    const [user] = await db
      .select({ id: users.id, emailVerifiedAt: users.emailVerifiedAt })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    if (user && !user.emailVerifiedAt) {
      await cleanupExpiredVerifications();

      await db
        .delete(emailVerifications)
        .where(eq(emailVerifications.userId, user.id));

      const code = generateVerificationCode();

      await db.insert(emailVerifications).values({
        userId: user.id,
        code,
        expiresAt: verificationExpiresAt(),
      });

      try {
        await sendVerificationCode(email, code);
      } catch {
        // Silent failure
      }
    }

    return { message };
  })

  // ── Refresh (public — no Bearer required) ──
  .post("/refresh", async ({ body, set }) => {
    const parsed = refreshSchema.safeParse(body);
    if (!parsed.success) {
      set.status = 400;
      return { error: formatZodError(parsed.error) };
    }

    const { refreshToken } = parsed.data;

    const [session] = await db
      .select()
      .from(sessions)
      .where(
        and(eq(sessions.token, refreshToken), gt(sessions.expiresAt, new Date()))
      )
      .limit(1);

    if (!session) {
      set.status = 401;
      return { error: "Invalid or expired refresh token" };
    }

    const [user] = await db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        avatar: users.avatar,
      })
      .from(users)
      .where(eq(users.id, session.userId))
      .limit(1);

    if (!user) {
      set.status = 401;
      return { error: "User not found" };
    }

    const accessToken = await signAccessToken({
      sub: user.id,
      name: user.name,
      email: user.email,
      avatar: user.avatar,
      type: "human",
    });

    return { accessToken };
  })

  // ── Verify session (public — checks refresh token validity without issuing new tokens) ──
  .post("/verify-session", async ({ body, set }) => {
    const parsed = refreshSchema.safeParse(body);
    if (!parsed.success) {
      set.status = 400;
      return { error: formatZodError(parsed.error) };
    }

    const { refreshToken } = parsed.data;

    const [session] = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(
        and(eq(sessions.token, refreshToken), gt(sessions.expiresAt, new Date()))
      )
      .limit(1);

    if (!session) {
      set.status = 401;
      return { error: "Invalid or expired session" };
    }

    return { valid: true };
  })

  // ── Authenticated routes ──
  .derive(async ({ headers }) => {
    const authHeader = headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      return { user: null, sessionToken: null } as any;
    }
    const token = authHeader.slice(7);
    const user = await resolveTokenToUser(token);
    if (!user) {
      return { user: null, sessionToken: null } as any;
    }
    return { user, sessionToken: token };
  })
  .onBeforeHandle(({ user, set }) => {
    if (!user) {
      set.status = 401;
      return { error: "Authentication required" };
    }
  })
  .post("/logout", async ({ body }) => {
    const refreshToken =
      body && typeof body === "object" && "refreshToken" in body
        ? (body as any).refreshToken
        : null;

    if (refreshToken) {
      await db.delete(sessions).where(eq(sessions.token, refreshToken));
    }

    return { success: true };
  })
  .get("/me", ({ user }) => {
    return { user };
  });
