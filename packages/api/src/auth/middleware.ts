import { Elysia } from "elysia";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { bots, users } from "../db/schema";
import { verifyAccessToken } from "./jwt";

/**
 * Resolve a Bearer token to a user record.
 * - JWT (contains dots) → verify and reconstruct user from payload (0 DB queries)
 * - bot_ prefix → DB lookup (unchanged)
 */
export async function resolveTokenToUser(token: string) {
  // 1. JWT access token (has 2 dots)
  if (token.includes(".")) {
    const payload = await verifyAccessToken(token);
    if (!payload) return null;
    return {
      id: payload.sub,
      name: payload.name,
      email: payload.email,
      avatar: payload.avatar,
      type: payload.type,
    };
  }

  // 2. Bot API keys (no expiry)
  if (token.startsWith("bot_")) {
    const [bot] = await db
      .select({ userId: bots.userId })
      .from(bots)
      .where(eq(bots.apiKey, token))
      .limit(1);

    if (bot) {
      const [user] = await db
        .select({
          id: users.id,
          name: users.name,
          email: users.email,
          avatar: users.avatar,
          type: users.type,
        })
        .from(users)
        .where(eq(users.id, bot.userId))
        .limit(1);

      return user ?? null;
    }
  }

  return null;
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
  }
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
