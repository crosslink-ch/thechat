import { Elysia } from "elysia";
import { eq, and, gt } from "drizzle-orm";
import { db } from "../db";
import { sessions, users } from "../db/schema";

export const optionalAuth = new Elysia({ name: "optional-auth" }).derive(
  async ({ headers }) => {
    const authHeader = headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      return { user: null as typeof userResult | null };
    }

    const token = authHeader.slice(7);
    const [session] = await db
      .select()
      .from(sessions)
      .where(and(eq(sessions.token, token), gt(sessions.expiresAt, new Date())))
      .limit(1);

    if (!session) {
      return { user: null as typeof userResult | null };
    }

    const [userResult] = await db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        avatar: users.avatar,
      })
      .from(users)
      .where(eq(users.id, session.userId))
      .limit(1);

    return { user: userResult ?? null };
  }
);

export const requireAuth = new Elysia({ name: "require-auth" })
  .derive(async ({ headers }) => {
    const authHeader = headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      return { user: null, sessionToken: null } as any;
    }

    const token = authHeader.slice(7);
    const [session] = await db
      .select()
      .from(sessions)
      .where(and(eq(sessions.token, token), gt(sessions.expiresAt, new Date())))
      .limit(1);

    if (!session) {
      return { user: null, sessionToken: null } as any;
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
