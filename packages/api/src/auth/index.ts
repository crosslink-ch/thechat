import crypto from "crypto";
import { Elysia } from "elysia";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import { log } from "../logging";
import { rateLimit, session, users } from "../db/schema";
import {
  betterAuthRequestURL,
  handleBetterAuthRequest,
  isEmailVerificationRequired,
} from "./better-auth";
import { resolveTokenToUser } from "./middleware";

const authRouteLog = log.child({ component: "auth-routes" });
const authServiceUnavailable = {
  error: "Authentication service temporarily unavailable",
};

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

const verifyEmailSchema = z.object({
  email: z.email("Please enter a valid email address"),
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, "Verification code must be 6 digits"),
});

function formatZodError(error: z.ZodError): string {
  return error.issues[0]?.message ?? "Invalid input";
}

function extractBearerToken(headers: Record<string, string | undefined>) {
  const authHeader = headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) return null;
  return authHeader.slice(7);
}

function authErrorMessage(data: unknown, fallback: string) {
  if (!data || typeof data !== "object") return fallback;
  const value = data as {
    message?: unknown;
    error?: unknown | { message?: unknown };
  };
  if (typeof value.message === "string") return value.message;
  if (typeof value.error === "string") return value.error;
  if (
    value.error &&
    typeof value.error === "object" &&
    "message" in value.error &&
    typeof value.error.message === "string"
  ) {
    return value.error.message;
  }
  return fallback;
}

function extractSessionToken(data: unknown, headers: Headers) {
  const value = data as {
    token?: unknown;
    session?: { token?: unknown };
    sessionToken?: unknown;
  } | null;

  const token =
    headers.get("set-auth-token") ??
    value?.token ??
    value?.session?.token ??
    value?.sessionToken;
  return typeof token === "string" ? token : null;
}

type AuthRequestContext = {
  headers: Record<string, string | undefined>;
  request: Request;
  server: {
    requestIP(request: Request): { address: string } | null;
  } | null;
};

type ClientMetadata = {
  clientIp: string | null;
  userAgent: string | null;
};

function clientMetadata(context: AuthRequestContext): ClientMetadata {
  const trustedProxy = process.env.AUTH_TRUST_PROXY === "true";
  const trustedHeader = (
    process.env.AUTH_TRUSTED_IP_HEADER ?? "x-real-ip"
  ).toLowerCase();
  const proxyIp = trustedProxy
    ? context.headers[trustedHeader]?.trim() || null
    : null;
  const directIp = context.server?.requestIP(context.request)?.address ?? null;
  const validProxyIp =
    proxyIp &&
    !proxyIp.includes(",") &&
    (z.ipv4().safeParse(proxyIp).success || z.ipv6().safeParse(proxyIp).success)
      ? proxyIp
      : null;

  return {
    // A comma means a chain supplied by an unsanitized proxy. Refuse it rather
    // than letting a caller select the first address in the chain.
    clientIp: validProxyIp ?? directIp,
    userAgent: context.headers["user-agent"]?.slice(0, 512) ?? null,
  };
}

const wrapperRateLimitWindowMs = 60_000;
const wrapperRateLimitMax = 3;

async function consumeWrapperRateLimit(
  scope: "resend-verification" | "verify-email",
  clientIp: string | null,
) {
  if (
    process.env.NODE_ENV !== "production" &&
    process.env.BETTER_AUTH_RATE_LIMIT_ENABLED !== "true"
  ) {
    return { allowed: true, retryAfter: 0 };
  }

  const now = Date.now();
  const key = `thechat:${scope}:${clientIp ?? "unknown"}`;
  const rows = await db.execute<{ count: number; lastRequest: number }>(sql`
    INSERT INTO ${rateLimit} ("id", "key", "count", "last_request")
    VALUES (${crypto.randomUUID()}, ${key}, 1, ${now})
    ON CONFLICT ("key") DO UPDATE SET
      "count" = CASE
        WHEN ${now} - ${rateLimit.lastRequest} >= ${wrapperRateLimitWindowMs}
          THEN 1
        ELSE ${rateLimit.count} + 1
      END,
      "last_request" = CASE
        WHEN ${now} - ${rateLimit.lastRequest} >= ${wrapperRateLimitWindowMs}
          THEN ${now}
        ELSE ${rateLimit.lastRequest}
      END
    RETURNING "count", "last_request" AS "lastRequest"
  `);
  const row = rows[0];
  const count = Number(row?.count ?? 1);
  const windowStartedAt = Number(row?.lastRequest ?? now);
  return {
    allowed: count <= wrapperRateLimitMax,
    retryAfter: Math.max(
      1,
      Math.ceil((windowStartedAt + wrapperRateLimitWindowMs - now) / 1000),
    ),
  };
}

function internalAuthHeaders(metadata: ClientMetadata, initial?: HeadersInit) {
  const headers = new Headers(initial);
  headers.delete("x-thechat-client-ip");
  if (metadata.clientIp) {
    headers.set("x-thechat-client-ip", metadata.clientIp);
  }
  if (metadata.userAgent) headers.set("user-agent", metadata.userAgent);
  return headers;
}

async function callBetterAuth(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  headers?: HeadersInit,
) {
  const requestHeaders = new Headers(headers);
  if (body !== undefined)
    requestHeaders.set("content-type", "application/json");

  const handled = await handleBetterAuthRequest(
    new Request(betterAuthRequestURL(path), {
      method,
      headers: requestHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  const { response } = handled;

  const text = await response.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  return {
    ok: response.ok,
    status: response.status,
    data,
    token: extractSessionToken(data, response.headers),
    verificationDeliveryAttempted: handled.verificationDeliveryAttempted,
    verificationDeliveryFailed: handled.verificationDeliveryFailed,
    retryAfter:
      response.headers.get("retry-after") ??
      response.headers.get("x-retry-after"),
  };
}

function forwardRateLimitMetadata(
  set: { headers: Record<string, unknown> },
  retryAfter: string | null,
) {
  if (!retryAfter) return;
  set.headers["retry-after"] = retryAfter;
  set.headers["x-retry-after"] = retryAfter;
}

type HumanUserRow = {
  id: string;
  name: string;
  email: string | null;
  avatar: string | null;
  type: "human" | "bot";
  emailVerified: boolean;
};

function publicUser(user: HumanUserRow) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    avatar: user.avatar,
    type: user.type,
  };
}

async function findPublicUserByEmail(email: string) {
  const [user] = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      avatar: users.avatar,
      type: users.type,
      emailVerified: users.emailVerified,
    })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  return user ?? null;
}

async function authResponseForEmail(email: string, token: string) {
  const user = await findPublicUserByEmail(email);
  if (!user || user.type !== "human") {
    throw new Error("Better Auth returned a session for a missing human user");
  }

  return {
    accessToken: token,
    user: publicUser(user),
  };
}

async function revokeSessionToken(token: string) {
  const current = await resolveTokenToUser(token, { includeBotTokens: false });
  if (!current) return;

  const result = await callBetterAuth("POST", "/sign-out", undefined, {
    authorization: `Bearer ${token}`,
  });
  if (result.status >= 500) {
    throw new Error("Better Auth sign-out failed");
  }

  // Better Auth's bearer value is a signed cookie representation, while the
  // session table stores the raw token. Never compare the public bearer value
  // directly to session.token. Re-resolve through Better Auth instead and only
  // report success once revocation is authoritative.
  const remaining = await resolveTokenToUser(token, { includeBotTokens: false });
  if (remaining) {
    throw new Error("Better Auth did not revoke the session");
  }
}

export const authRoutes = new Elysia({ prefix: "/auth" })
  .onError(({ error, set }) => {
    authRouteLog.error({ err: error }, "Authentication route failed");
    set.status = 503;
    return authServiceUnavailable;
  })
  .post("/register", async ({ body, set, headers, request, server }) => {
    const parsed = registerSchema.safeParse(body);
    if (!parsed.success) {
      set.status = 400;
      return { error: formatZodError(parsed.error) };
    }

    const { name, email: rawEmail, password } = parsed.data;
    const email = rawEmail.toLowerCase();

    if (await findPublicUserByEmail(email)) {
      set.status = 409;
      return { error: "An account with this email already exists" };
    }

    const metadata = clientMetadata({ headers, request, server });
    const result = await callBetterAuth(
      "POST",
      "/sign-up/email",
      { name, email, password },
      internalAuthHeaders(metadata),
    );

    if (!result.ok) {
      if (result.status >= 500) {
        authRouteLog.error(
          { upstreamStatus: result.status },
          "Better Auth registration failed",
        );
        set.status = 503;
        return authServiceUnavailable;
      }
      if (result.status === 429) {
        forwardRateLimitMetadata(set, result.retryAfter);
      }
      set.status = result.status === 422 ? 409 : result.status;
      return { error: authErrorMessage(result.data, "Registration failed") };
    }

    const registered = await findPublicUserByEmail(email);
    if (isEmailVerificationRequired()) {
      // Registration must never leave an authenticated session before the
      // configured verification policy is satisfied.
      if (registered) {
        await db.delete(session).where(eq(session.userId, registered.id));
      }

      const deliveryFailed =
        !result.verificationDeliveryAttempted ||
        result.verificationDeliveryFailed;
      if (deliveryFailed) {
        authRouteLog.error(
          {
            attempted: result.verificationDeliveryAttempted,
            failed: result.verificationDeliveryFailed,
          },
          "Registration created a verification-pending account but email delivery failed",
        );
      }

      return {
        message: deliveryFailed
          ? "Account created, but we could not deliver the code. Use Send a new code to retry."
          : "Registration successful. Check your email for a 6-digit verification code.",
      };
    }

    if (!result.token) {
      authRouteLog.error(
        { upstreamStatus: result.status },
        "Better Auth registration succeeded without a session token",
      );
      set.status = 503;
      return authServiceUnavailable;
    }

    return authResponseForEmail(email, result.token);
  })

  .post("/login", async ({ body, set, headers, request, server }) => {
    const parsed = loginSchema.safeParse(body);
    if (!parsed.success) {
      set.status = 400;
      return { error: formatZodError(parsed.error) };
    }

    const { email: rawEmail, password } = parsed.data;
    const email = rawEmail.toLowerCase();
    const metadata = clientMetadata({ headers, request, server });
    const result = await callBetterAuth(
      "POST",
      "/sign-in/email",
      { email, password, rememberMe: true },
      internalAuthHeaders(metadata),
    );

    if (!result.ok || !result.token) {
      if (result.status >= 500 || (result.ok && !result.token)) {
        authRouteLog.error(
          { upstreamStatus: result.status },
          "Better Auth login failed",
        );
        set.status = 503;
        return authServiceUnavailable;
      }
      if (result.status === 429) {
        forwardRateLimitMetadata(set, result.retryAfter);
        set.status = 429;
        return {
          error: authErrorMessage(result.data, "Too many login attempts"),
        };
      }
      if (result.status === 403) {
        set.status = 403;
        return { error: "Please verify your email before logging in" };
      }
      set.status = 401;
      return { error: "Invalid email or password" };
    }

    return authResponseForEmail(email, result.token);
  })

  .post("/verify-email", async ({ body, set, headers, request, server }) => {
    const parsed = verifyEmailSchema.safeParse(body);
    if (!parsed.success) {
      set.status = 400;
      return { error: formatZodError(parsed.error) };
    }

    const email = parsed.data.email.toLowerCase();
    const metadata = clientMetadata({ headers, request, server });
    const rateLimitResult = await consumeWrapperRateLimit(
      "verify-email",
      metadata.clientIp,
    );
    if (!rateLimitResult.allowed) {
      const retryAfter = String(rateLimitResult.retryAfter);
      forwardRateLimitMetadata(set, retryAfter);
      set.status = 429;
      return { error: "Too many verification attempts" };
    }

    const user = await findPublicUserByEmail(email);
    const genericError = { error: "Invalid or expired verification code" };
    if (!user || user.type !== "human" || user.emailVerified) {
      set.status = 400;
      return genericError;
    }

    const result = await callBetterAuth(
      "POST",
      "/email-otp/verify-email",
      { email, otp: parsed.data.code },
      internalAuthHeaders(metadata),
    );

    if (!result.ok) {
      if (result.status >= 500) {
        authRouteLog.error(
          { upstreamStatus: result.status },
          "Better Auth OTP verification failed",
        );
        set.status = 503;
        return authServiceUnavailable;
      }
      if (result.status === 429) {
        forwardRateLimitMetadata(set, result.retryAfter);
        set.status = 429;
        return {
          error: authErrorMessage(
            result.data,
            "Too many verification attempts",
          ),
        };
      }
      set.status = 400;
      const message = authErrorMessage(result.data, genericError.error);
      return {
        error: /too many/i.test(message)
          ? "Too many incorrect attempts. Request a new code and try again."
          : genericError.error,
      };
    }

    await db
      .update(users)
      .set({ emailVerified: true })
      .where(eq(users.id, user.id));

    if (!result.token) {
      authRouteLog.error(
        { upstreamStatus: result.status },
        "Better Auth verification succeeded without a session token",
      );
      set.status = 503;
      return authServiceUnavailable;
    }

    return authResponseForEmail(email, result.token);
  })

  .post(
    "/resend-verification",
    async ({ body, set, headers, request, server }) => {
      const parsed = resendVerificationSchema.safeParse(body);
      const message =
        "If that email is registered and unverified, a delivery attempt will be made.";

      if (!parsed.success) return { message };

      const email = parsed.data.email.toLowerCase();
      const metadata = clientMetadata({ headers, request, server });
      // Consume the shared outer bucket before account lookup. Unknown, verified,
      // and unverified addresses therefore reach 429 on the same request while
      // only real unverified users trigger email delivery.
      const rateLimitResult = await consumeWrapperRateLimit(
        "resend-verification",
        metadata.clientIp,
      );
      if (!rateLimitResult.allowed) {
        const retryAfter = String(rateLimitResult.retryAfter);
        forwardRateLimitMetadata(set, retryAfter);
        set.status = 429;
        return { error: "Too many requests" };
      }

      const user = await findPublicUserByEmail(email);
      if (user?.type === "human" && !user.emailVerified) {
        const result = await callBetterAuth(
          "POST",
          "/email-otp/send-verification-otp",
          { email, type: "email-verification" },
          internalAuthHeaders(metadata),
        );
        if (
          result.status >= 500 ||
          !result.verificationDeliveryAttempted ||
          result.verificationDeliveryFailed
        ) {
          authRouteLog.error(
            {
              upstreamStatus: result.status,
              attempted: result.verificationDeliveryAttempted,
              failed: result.verificationDeliveryFailed,
            },
            "Better Auth OTP resend failed",
          );
          // The public response remains account-state independent. Provider
          // failures are visible through the structured operational log.
        }
      }

      return { message };
    },
  )

  .get("/me", async ({ headers, set }) => {
    const token = extractBearerToken(headers);
    if (!token) {
      set.status = 401;
      return { error: "Authentication required" };
    }

    const user = await resolveTokenToUser(token);
    if (!user) {
      set.status = 401;
      return { error: "Authentication required" };
    }

    return { user };
  })

  .post("/logout", async ({ headers }) => {
    const token = extractBearerToken(headers);
    if (token && !token.startsWith("bot_")) {
      await revokeSessionToken(token);
    }
    return { success: true };
  });
