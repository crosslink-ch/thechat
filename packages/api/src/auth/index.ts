import { Elysia, t } from "elysia";
import { eq, and, gt } from "drizzle-orm";
import { db } from "../db";
import { users, sessions, emailVerifications } from "../db/schema";
import { requireAuth } from "./middleware";
import { sendVerificationEmail } from "./email";
import crypto from "crypto";

function generateToken(): string {
  return crypto.randomBytes(32).toString("hex"); // 64 hex chars
}

function sessionExpiresAt(): Date {
  const d = new Date();
  d.setFullYear(d.getFullYear() + 1);
  return d;
}

const requireEmailVerification =
  process.env.REQUIRE_EMAIL_VERIFICATION === "true";

export const authRoutes = new Elysia({ prefix: "/auth" })
  // ── Register ──
  .post(
    "/register",
    async ({ body, set }) => {
      const { name, email, password } = body;

      // Check email uniqueness
      const [existing] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, email))
        .limit(1);

      if (existing) {
        set.status = 409;
        return { error: "Email already registered" };
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
        });

      if (requireEmailVerification) {
        // Send verification email
        const token = generateToken();
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

      // Auto-login: create session
      const token = generateToken();
      await db.insert(sessions).values({
        userId: user.id,
        token,
        expiresAt: sessionExpiresAt(),
      });

      return { token, user };
    },
    {
      body: t.Object({
        name: t.String({ minLength: 1 }),
        email: t.String({ format: "email" }),
        password: t.String({ minLength: 8 }),
      }),
    }
  )

  // ── Login ──
  .post(
    "/login",
    async ({ body, set }) => {
      const { email, password } = body;

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

      if (requireEmailVerification && !user.emailVerifiedAt) {
        set.status = 403;
        return { error: "Please verify your email before logging in" };
      }

      const token = generateToken();
      await db.insert(sessions).values({
        userId: user.id,
        token,
        expiresAt: sessionExpiresAt(),
      });

      return {
        token,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          avatar: user.avatar,
        },
      };
    },
    {
      body: t.Object({
        email: t.String({ format: "email" }),
        password: t.String({ minLength: 1 }),
      }),
    }
  )

  // ── Logout ──
  .use(requireAuth)
  .post("/logout", async ({ sessionToken }) => {
    await db.delete(sessions).where(eq(sessions.token, sessionToken));
    return { success: true };
  })

  // ── Get current user ──
  .get("/me", ({ user }) => {
    return { user };
  })

  // ── Verify email ──
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
      .where(eq(users.id, verification.userId));

    await db
      .delete(emailVerifications)
      .where(eq(emailVerifications.id, verification.id));

    set.headers["content-type"] = "text/html";
    return "<h1>Email verified successfully!</h1><p>You can now log in.</p>";
  })

  // ── Resend verification ──
  .post(
    "/resend-verification",
    async ({ body }) => {
      const { email } = body;

      const [user] = await db
        .select({ id: users.id, emailVerifiedAt: users.emailVerifiedAt })
        .from(users)
        .where(eq(users.email, email))
        .limit(1);

      // Silent success if not found (prevent email enumeration)
      if (user && !user.emailVerifiedAt) {
        // Delete old verifications
        await db
          .delete(emailVerifications)
          .where(eq(emailVerifications.userId, user.id));

        const token = generateToken();
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

      return {
        message: "If that email is registered, a verification link has been sent.",
      };
    },
    {
      body: t.Object({
        email: t.String({ format: "email" }),
      }),
    }
  );
