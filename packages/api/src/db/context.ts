import { AsyncLocalStorage } from "node:async_hooks";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type * as schema from "./schema";

export type DatabaseScope = "actor" | "personal" | `workspace:${string}`;
export type DatabaseActor = { actorId: string; scope: DatabaseScope };
export type DatabaseExecutor = PostgresJsDatabase<typeof schema>;
type DatabaseState = {
  authority: "actor" | "worker";
  actor?: DatabaseActor;
  executor?: DatabaseExecutor;
  active: boolean;
};
export const databaseContext = new AsyncLocalStorage<DatabaseState>();

/** Trusted transport delivery starts a new request, never inherits a sender's
 * transaction/identity. The caller must validate the recipient/session first. */
export function withIndependentActorDatabaseContext<T>(actor: DatabaseActor, operation: () => T | Promise<T>) {
  return databaseContext.run(undefined as unknown as DatabaseState, () => withDatabaseContext(actor, operation));
}

export function requireDatabaseContext() {
  const state = databaseContext.getStore();
  if (!state?.active) throw new Error("Database actor/scope context is required");
  return state;
}

/** Bind authenticated identity, never request-body/user-supplied actor IDs. */
export async function withDatabaseContext<T>(actor: DatabaseActor, operation: () => T | Promise<T>): Promise<T> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(actor.actorId)
    || !(actor.scope === "actor" || actor.scope === "personal" || /^workspace:.{1,100}$/.test(actor.scope))) {
    throw new Error("Invalid database actor/scope");
  }
  const existing = databaseContext.getStore();
  if (existing?.active && existing.authority === "actor") {
    if (existing.actor!.actorId !== actor.actorId || existing.actor!.scope !== actor.scope) {
      throw new Error("Cannot replace authenticated database actor/scope");
    }
    return operation();
  }
  const state: DatabaseState = { authority: "actor", actor: { ...actor }, active: true };
  try { return await databaseContext.run(state, async () => await operation()); }
  finally { state.active = false; }
}

/** Explicit maintenance entrypoint; no ambient fallback to worker authority. */
export async function withWorkerDatabaseContext<T>(operation: () => T | Promise<T>): Promise<T> {
  if (databaseContext.getStore()?.authority === "actor") {
    throw new Error("Authenticated requests cannot elevate to worker authority");
  }
  const state: DatabaseState = { authority: "worker", active: true };
  try { return await databaseContext.run(state, async () => await operation()); }
  finally { state.active = false; }
}
