import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL environment variable is required");
}

export const client = postgres(databaseUrl, databasePoolOptions(process.env));
export const db = drizzle({ client, schema });

/**
 * Optional pool sizing. Production connects through PgBouncer in session mode,
 * where every open client connection pins a server connection, so processes
 * that run many replicas (the worker) use a smaller pool and close idle
 * connections. Unset variables keep the postgres.js defaults.
 */
export function databasePoolOptions(env: NodeJS.ProcessEnv) {
  const max = positiveInteger(env.DATABASE_POOL_MAX);
  const idleTimeout = positiveInteger(env.DATABASE_IDLE_TIMEOUT_SECONDS);
  return {
    ...(max ? { max } : {}),
    ...(idleTimeout ? { idle_timeout: idleTimeout } : {}),
  };
}

function positiveInteger(value: string | undefined) {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}
