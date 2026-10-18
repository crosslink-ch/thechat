import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import * as schema from "./schema";
import { verifyAuthenticationDatabase, verifyRuntimeDatabase, verifyWorkerDatabase } from "./role";
import { databaseContext, requireDatabaseContext, type DatabaseExecutor } from "./context";
export { withDatabaseContext, withWorkerDatabaseContext } from "./context";

const connections = new Map<string, { client: postgres.Sql; database: DatabaseExecutor }>();
function connection(environment: "DATABASE_URL" | "DATABASE_AUTH_URL" | "DATABASE_WORKER_URL") {
  const url = process.env[environment];
  if (!url) throw new Error(`${environment} environment variable is required`);
  let entry = connections.get(environment);
  if (!entry) {
    const client = postgres(url, { max: Number(process.env.DATABASE_POOL_SIZE ?? 10) });
    entry = { client, database: drizzle({ client, schema }) };
    connections.set(environment, entry);
  }
  return entry.database;
}

/** Better Auth/global credential storage has no collaboration grants. */
function authenticationFacade(): DatabaseExecutor {
  const facade = {} as DatabaseExecutor;
  // Keep this lazy: worker/migration workloads do not receive auth credentials.
  // These are Drizzle's own fields and public builder methods, not DB defaults.
  for (const key of ['$with', '$count', 'with', 'select', 'selectDistinct', 'selectDistinctOn', 'update', 'insert', 'delete', 'refreshMaterializedView', 'execute', 'transaction']) {
    Reflect.set(facade, key, (...args: unknown[]) => {
      const database = connection('DATABASE_AUTH_URL');
      return Reflect.get(database, key).apply(database, args);
    });
  }
  for (const key of ['_', 'query', 'dialect', 'session', '$cache', '$client', 'authToken']) {
    Object.defineProperty(facade, key, {
      configurable: true,
      get: () => Reflect.get(connection('DATABASE_AUTH_URL'), key),
    });
  }
  return facade;
}
// An ordinary object (not a Proxy) preserves Bun spy/property semantics, while
// its forwarding methods/getters allow explicit pool shutdown/reinitialization.
export const authDb = authenticationFacade();

let runtimeSafety: Promise<void> | undefined;
let workerSafety: Promise<void> | undefined;
export function assertWorkerDatabaseSafety() {
  workerSafety ??= verifyWorkerDatabase(connection('DATABASE_WORKER_URL'));
  return workerSafety;
}
export function assertDatabaseSafety() {
  runtimeSafety ??= Promise.all([
    verifyRuntimeDatabase(connection("DATABASE_URL")),
    verifyAuthenticationDatabase(connection("DATABASE_AUTH_URL")),
  ]).then(() => undefined);
  return runtimeSafety;
}

async function inTransaction<T>(operation: (tx: DatabaseExecutor) => Promise<T>, config?: Parameters<DatabaseExecutor['transaction']>[1]) {
  const state = requireDatabaseContext();
  if (state.authority === "actor") await assertDatabaseSafety();
  else await assertWorkerDatabaseSafety();
  if (state.executor) return operation(state.executor);
  const database = connection(state.authority === "worker" ? "DATABASE_WORKER_URL" : "DATABASE_URL");
  return database.transaction(async tx => {
    if (state.authority === "actor") {
      await tx.execute(sql`select set_config('thechat.actor_id', ${state.actor!.actorId}, true), set_config('thechat.scope', ${state.actor!.scope}, true)`);
    }
    const transactionState = { ...state, executor: tx as unknown as DatabaseExecutor, active: true };
    try { return await databaseContext.run(transactionState, () => operation(tx as unknown as DatabaseExecutor)); }
    finally { transactionState.active = false; }
  }, config);
}

type Step = { key: PropertyKey; args?: unknown[] };
// Drizzle queries are lazy. Replay the fluent builder on the transaction-bound
// executor at await time, rather than ever executing on an unscoped pool client.
function query(steps: Step[]): any {
  const replay = (executor: DatabaseExecutor): any => {
    let value: any = executor;
    for (const step of steps) {
      value = step.args ? Reflect.get(value, step.key).apply(value, step.args) : Reflect.get(value, step.key);
    }
    return value;
  };
  return new Proxy(() => undefined, {
    get(_target, key) {
      if (key === "then") return (resolve: any, reject: any) => inTransaction(async tx => await replay(tx)).then(resolve, reject);
      if (key === "toSQL") return () => replay(connection("DATABASE_URL")).toSQL();
      if (key === "prepare") throw new Error("Unscoped prepared queries are not supported; execute inside a database context");
      return query([...steps, { key }]);
    },
    apply(_target, _this, args) {
      const last = steps.at(-1)!;
      return query([...steps.slice(0, -1), { key: last.key, args }]);
    },
  });
}

/** All collaboration access fails closed unless bound to explicit authority. */
export const db = new Proxy({} as DatabaseExecutor, {
  get(_target, key) {
    if (key === "transaction") return async (operation: (tx: any) => Promise<unknown>, config?: any) => {
      const current = requireDatabaseContext();
      if (!current.executor) return inTransaction(async tx => operation(tx), config);
      return current.executor.transaction(async tx => {
        const nested = { ...current, executor: tx as unknown as DatabaseExecutor, active: true };
        try { return await databaseContext.run(nested, () => operation(tx)); }
        finally { nested.active = false; }
      }, config);
    };
    return query([{ key }]);
  },
});

export async function checkDatabaseHealth() {
  await assertDatabaseSafety();
  const [row] = await connection('DATABASE_URL').execute<{ actor: string | null; scope: string | null }>(sql`select current_setting('thechat.actor_id',true) as actor,current_setting('thechat.scope',true) as scope`);
  if (!row || row.actor || row.scope) throw new Error('Leaked database pool actor/scope context');
  return true;
}

export async function closeDatabaseConnections() {
  runtimeSafety = undefined;
  workerSafety = undefined;
  await Promise.all([...connections.values()].map(entry => entry.client.end()));
  connections.clear();

}
