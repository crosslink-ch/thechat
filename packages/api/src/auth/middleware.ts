import { Elysia } from "elysia";
import { eq, and, gt } from "drizzle-orm";
import { db } from "../db";
import { sessions, users, bots } from "../db/schema";

/**
 * Resolve a Bearer token to a user record.
 * Checks session tokens first, then bot API keys.
 */
export async function resolveTokenToUser(token: string) {
  // 1. Check sessions (with expiry)
  const [session] = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.token, token), gt(sessions.expiresAt, new Date())))
    .limit(1);

  if (session) {
    const [user] = await db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        avatar: users.avatar,
        type: users.type,
      })
      .from(users)
      .where(eq(users.id, session.userId))
      .limit(1);

    return user ?? null;
  }

  // 2. Check bot API keys (no expiry)
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
