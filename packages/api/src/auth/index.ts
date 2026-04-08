import { Elysia } from "elysia";
import { eq, and, gt, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import { users, sessions, emailVerifications } from "../db/schema";
import { sendVerificationEmail } from "./email";
import { resolveTokenToUser } from "./middleware";
import { signAccessToken } from "./jwt";
import crypto from "crypto";

function generateRefreshToken(): string {
  return crypto.randomBytes(32).toString("hex"); // 64 hex chars
}

function sessionExpiresAt(): Date {
  const d = new Date();
  d.setFullYear(d.getFullYear() + 1);
  return d;
}

function isEmailVerificationRequired() {
  return process.env.REQUIRE_EMAIL_VERIFICATION === "true";
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
      const token = generateRefreshToken();
      const expiresAt = new Date();
      expiresAt.setHours(expiresAt.getHours() + 24);

      await db.insert(emailVerifications).values({
        userId: user.id,
        token,
        expiresAt,
      });

      try {
        await sendVerificationEmail(email, token);
      } catch {
        // Don't fail registration if email fails
      }

      return {
        message:
          "Registration successful. Please check your email to verify your account.",
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

  // ── Verify email (public) ──
  // Note: this handler is intentionally idempotent and does NOT delete the
  // verification row on success. Many email security scanners (Outlook Safe
  // Links, Mimecast, ProofPoint, etc.) pre-fetch links in incoming mail; if
  // we deleted the row on first GET, the user's actual click would then look
  // like an "expired" token. The row is allowed to age out via its 24h
  // expiresAt instead, and re-clicking the same link is a no-op success.
  .get("/verify-email", async ({ query, set }) => {
    const { token } = query;
    if (!token) {
      set.status = 400;
      set.headers["content-type"] = "text/html";
      return "<h1>Invalid verification link</h1>";
    }

    const [verification] = await db
      .select()
      .from(emailVerifications)
      .where(
        and(
          eq(emailVerifications.token, token),
          gt(emailVerifications.expiresAt, new Date())
        )
      )
      .limit(1);

    if (!verification) {
      set.status = 400;
      set.headers["content-type"] = "text/html";
      return "<h1>Invalid or expired verification link</h1>";
    }

    await db
      .update(users)
      .set({ emailVerifiedAt: new Date() })
      .where(
        and(eq(users.id, verification.userId), isNull(users.emailVerifiedAt))
      );

    set.headers["content-type"] = "text/html";
    return "<h1>Email verified successfully!</h1><p>You can now log in.</p>";
  })

  // ── Resend verification ──
  .post("/resend-verification", async ({ body }) => {
    const parsed = resendVerificationSchema.safeParse(body);
    // Always return same message to prevent email enumeration
    const message =
      "If that email is registered, a verification link has been sent.";

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
      await db
        .delete(emailVerifications)
        .where(eq(emailVerifications.userId, user.id));

      const token = generateRefreshToken();
      const expiresAt = new Date();
      expiresAt.setHours(expiresAt.getHours() + 24);

      await db.insert(emailVerifications).values({
        userId: user.id,
        token,
        expiresAt,
      });

      try {
        await sendVerificationEmail(email, token);
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
