import { Elysia } from "elysia";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { bots, session, users } from "../db/schema";
import {
  auth,
  isEmailVerificationRequired,
  PERSONAL_ACCESS_TOKEN_PREFIX,
} from "./better-auth";
import { verifyBotApiKey } from "./bot-api-keys";
import { verifyPersonalAccessToken } from "./personal-access-tokens";
import { log } from "../logging";

const authMiddlewareLog = log.child({ component: "auth-middleware" });

export const authServiceUnavailable = {
  error: "Authentication service temporarily unavailable",
};

export class AuthInfrastructureError extends Error {
  constructor(cause: unknown) {
    super(authServiceUnavailable.error, { cause });
    this.name = "AuthInfrastructureError";
  }
}

export const authInfrastructureErrors = new Elysia({
  name: "auth-infrastructure-errors",
}).onError({ as: "global" }, ({ error, set }) => {
  if (!(error instanceof AuthInfrastructureError)) return;
  set.status = 503;
  return authServiceUnavailable;
});

type ResolvedUser = {
  id: string;
  name: string;
  email: string | null;
  avatar: string | null;
  type: "human" | "bot";
};

async function loadHumanUser(userId: string): Promise<ResolvedUser | null> {
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
    .where(eq(users.id, userId))
    .limit(1);

  if (!user || user.type !== "human") return null;

  if (isEmailVerificationRequired() && !user.emailVerified) {
    // A policy change from optional to required invalidates sessions created
    // under the earlier policy. The shared table makes this replica-safe.
    await db.delete(session).where(eq(session.userId, user.id));
    return null;
  }

  return {
    id: user.id,
    name: user.name,
    email: user.email,
    avatar: user.avatar,
    type: user.type,
  };
}

async function resolveSessionToken(token: string) {
  const betterAuthSession = await auth.api.getSession({
    headers: new Headers({ authorization: `Bearer ${token}` }),
  });
  if (!betterAuthSession?.user?.id) return null;
  return loadHumanUser(betterAuthSession.user.id);
}

export async function resolveSessionTokenToHumanUser(token: string) {
  try {
    return await resolveSessionToken(token);
  } catch (error) {
    if (error instanceof AuthInfrastructureError) throw error;
    authMiddlewareLog.error({ err: error }, "Session authentication lookup failed");
    throw new AuthInfrastructureError(error);
  }
}

/**
 * Resolve a Bearer credential in strict order: human session, bot key, then
 * personal access token. Personal tokens are accepted only for human users.
 */
export async function resolveTokenToUser(
  token: string,
  options: { includeBotTokens?: boolean } = {},
) {
  const includeBotTokens = options.includeBotTokens ?? true;

  try {
    const sessionUser = await resolveSessionToken(token);
    if (sessionUser) return sessionUser;

    if (token.startsWith("bot_")) {
      if (!includeBotTokens) return null;

      const botUserId = await verifyBotApiKey(token);
      if (!botUserId) return null;

      const [user] = await db
        .select({
          id: users.id,
          name: users.name,
          email: users.email,
          avatar: users.avatar,
          type: users.type,
          botId: bots.id,
          attachmentAccess: bots.attachmentAccess,
        })
        .from(users)
        .innerJoin(bots, eq(bots.userId, users.id))
        .where(
          and(
            eq(users.id, botUserId),
            eq(users.type, "bot"),
            eq(bots.userId, botUserId),
          ),
        )
        .limit(1);

      return user ?? null;
    }

    if (token.startsWith(PERSONAL_ACCESS_TOKEN_PREFIX)) {
      const userId = await verifyPersonalAccessToken(token);
      if (!userId) return null;
      return loadHumanUser(userId);
    }

    return null;
  } catch (error) {
    if (error instanceof AuthInfrastructureError) throw error;
    // Session/user-store failures are infrastructure failures, not evidence
    // that a credential is invalid. Route boundaries map this typed error to
    // a sanitized, retryable 503 without leaking database/driver details.
    authMiddlewareLog.error({ err: error }, "Authentication lookup failed");
    throw new AuthInfrastructureError(error);
  }
}

export const optionalAuth = new Elysia({ name: "optional-auth" }).derive(
  async ({ headers }) => {
    const authHeader = headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      return { user: null as Awaited<ReturnType<typeof resolveTokenToUser>> };
    }

    const token = authHeader.slice(7);
    const user = await resolveTokenToUser(token);
    return { user };
  },
);

export const requireAuth = new Elysia({ name: "require-auth" })
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
  });
