/**
 * Helpers for integration tests that run outside the API package
 * (e.g. desktop hook tests) and need DB cleanup.
 */
import { db } from "./db";
import { users, workspaces } from "./db/schema";
import { eq } from "drizzle-orm";

export async function cleanupWorkspace(id: string) {
  await db.delete(workspaces).where(eq(workspaces.id, id));
}

export async function cleanupUserByEmail(email: string) {
  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (user) {
    await db.delete(users).where(eq(users.id, user.id));
  }
}
