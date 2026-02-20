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

export const requireAuth = new Elysia({ name: "require-auth" }).derive(
  async ({ headers, set }) => {
    const authHeader = headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      set.status = 401;
      throw new Error("Authentication required");
    }

    const token = authHeader.slice(7);
    const [session] = await db
      .select()
      .from(sessions)
      .where(and(eq(sessions.token, token), gt(sessions.expiresAt, new Date())))
      .limit(1);

    if (!session) {
      set.status = 401;
      throw new Error("Invalid or expired session");
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
      throw new Error("User not found");
    }

    return { user, sessionToken: token };
  }
);
