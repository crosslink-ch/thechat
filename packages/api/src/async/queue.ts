import {
  PgBoss,
  fromDrizzle,
  type Db,
  type JobWithMetadata,
  type Queue,
} from "pg-boss";
import { sql } from "drizzle-orm";
import { db } from "../db";
import { Pool } from "pg";
import { log } from "../logging";
import {
  contextFromTraceContext,
  traceContextFromContext,
} from "../observability";
import { metrics, type ObservableResult } from "@opentelemetry/api";

export const QUEUES = {
  chat: "chat.message.sent",
  attachments: "attachment.work",
  answers: "bot-request.answer",
  bots: "bot.dispatch",
  push: "push.notification",
} as const;
export type QueueId = (typeof QUEUES)[keyof typeof QUEUES];
export const queueConfig = {
  concurrency: {
    [QUEUES.chat]: 16,
    [QUEUES.attachments]: 1,
    [QUEUES.answers]: 4,
    [QUEUES.bots]: 4,
    [QUEUES.push]: 8,
  },
  pollingIntervalSeconds: 0.5,
  heartbeatSeconds: 60,
  expireInSeconds: 6 * 60 * 60,
  retryLimit: 7,
  retryDelay: 2,
  retryBackoff: true,
  retryDelayMax: 300,
  retentionSeconds: 10 * 365 * 24 * 60 * 60,
  deleteAfterSeconds: 30 * 24 * 60 * 60,
  shutdownTimeoutMs: 20_000,
};
export type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type Executor = Pick<typeof db, "execute">;

/** pg-boss lifecycle/maintenance uses pg, with ONE explicitly bounded pool shared
 * by all clients in this process. Business transactions still use postgres-js
 * and the official fromDrizzle(tx, sql) adapter; there is no cross-DB dual write.
 * No LISTEN connection. Budget: application pool + 2 connections per process.
 */
export function normalizeResults(result: any): { rows: any[] } {
  if (!Array.isArray(result)) return result;
  if (result.every((value) => Array.isArray(value?.rows)))
    return { rows: result.flatMap((value) => value.rows) };
  if (result.every(Array.isArray)) return { rows: result.flat() };
  return { rows: result };
}
let pool: Pool | undefined;
export const queueDatabase: Db = {
  async executeSql(text, values = []) {
    if (!pool) {
      pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        max: 2,
        idleTimeoutMillis: 10_000,
        connectionTimeoutMillis: 10_000,
        application_name: "thechat-pgboss",
      });
      pool.on("error", () =>
        log.error({ component: "pg-boss" }, "Queue database connection failed"),
      );
    }
    return normalizeResults(await pool.query(text, values));
  },
};
export async function closeQueueDatabase() {
  const current = pool;
  pool = undefined;
  await current?.end();
}

export function createQueueClient(
  options: { worker?: boolean; migrate?: boolean } = {},
) {
  const boss = new PgBoss({
    db: queueDatabase,
    schema: "pgboss",
    migrate: options.migrate ?? false,
    createSchema: options.migrate ?? false,
    supervise: options.worker ?? false,
    schedule: false,
    useListenNotify: false,
    registerInstance: options.worker ?? false,
    instanceName: options.worker ? "thechat-worker" : "thechat-producer",
    reindex: false,
    persistQueueStats: false,
    openTelemetry: {
      enabled: true,
      propagateContext: true,
      propagator: {
        fields: () => ["traceparent", "tracestate"],
        inject(context, carrier, setter) {
          const value = traceContextFromContext(context);
          if (value) {
            setter.set(carrier, "traceparent", value.traceparent);
            if (value.tracestate)
              setter.set(carrier, "tracestate", value.tracestate);
          }
        },
        extract(context, carrier, getter) {
          const parent = getter.get(carrier, "traceparent");
          const state = getter.get(carrier, "tracestate");
          return typeof parent === "string"
            ? contextFromTraceContext({
                traceparent: parent,
                ...(typeof state === "string" ? { tracestate: state } : {}),
              })
            : context;
        },
      },
    },
  });
  // Do not log pg/Drizzle errors verbatim: they may contain parameters/payloads.
  boss.on("error", (error) =>
    log.error(
      { component: "pg-boss", errorType: error.name },
      "Queue operation failed",
    ),
  );
  boss.on("warning", () => log.warn({ component: "pg-boss" }, "Queue warning"));
  return boss;
}
let producer: Promise<PgBoss> | undefined;
export function getQueueClient() {
  return (producer ??= (async () => {
    const boss = createQueueClient();
    try {
      await boss.start();
      const names = new Set((await boss.getQueues()).map((q) => q.name));
      if (Object.values(QUEUES).some((name) => !names.has(name)))
        throw Error("Missing queues");
      const [audit] = await db.execute(
        sql`select to_regclass('public.queue_dead_letters') as audit, to_regclass('public.queue_legacy_imports') as receipts`,
      );
      if (!audit.audit || !audit.receipts)
        throw Error("Missing queue audit schema");
    } catch {
      await boss.stop();
      throw new Error(
        "pg-boss schema unavailable or incompatible; run pnpm --filter @thechat/api queue:setup before starting TheChat",
      );
    }
    return boss;
  })().catch((error) => {
    producer = undefined;
    throw error;
  }));
}
export async function closeQueueClient() {
  const current = producer;
  producer = undefined;
  if (current) await (await current).stop();
}

/** Only the explicit setup command invokes DDL, never an import or API start. */
export async function setupQueues() {
  const boss = createQueueClient({ migrate: true });
  try {
    await boss.start();
    for (const name of Object.values(QUEUES)) {
      const config: Omit<Queue, "name"> = {
        policy: name === QUEUES.chat ? "key_strict_fifo" : "standard",
        partition: false,
        retryLimit: queueConfig.retryLimit,
        retryDelay: queueConfig.retryDelay,
        retryBackoff: true,
        retryDelayMax: queueConfig.retryDelayMax,
        expireInSeconds: queueConfig.expireInSeconds,
        heartbeatSeconds: queueConfig.heartbeatSeconds,
        retentionSeconds: queueConfig.retentionSeconds,
        deleteAfterSeconds: queueConfig.deleteAfterSeconds,
        notify: false,
      };
      await boss.createQueue(name, config);
      const actual = await boss.getQueue(name);
      if (actual?.policy !== config.policy)
        throw Error(`Incompatible queue policy: ${name}`);
      const { policy, partition, ...mutable } = config;
      await boss.updateQueue(name, mutable);
    }
    await queueDatabase.executeSql(`
      CREATE TABLE IF NOT EXISTS public.queue_dead_letters (
        queue text NOT NULL, id uuid NOT NULL, data jsonb NOT NULL, singleton_key text,
        attempts integer NOT NULL, error jsonb, created_at timestamptz NOT NULL,
        dead_at timestamptz NOT NULL DEFAULT now(), replay_id uuid, replayed_at timestamptz,
        PRIMARY KEY(queue,id)
      );
      CREATE TABLE IF NOT EXISTS public.queue_legacy_imports (
        source text NOT NULL, id text NOT NULL, queue text NOT NULL, job_id uuid NOT NULL,
        imported_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(source,id)
      );
      CREATE OR REPLACE FUNCTION public.keep_failed_queue_job() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.state = 'failed' THEN NEW.deletion_seconds := 0; END IF;
        RETURN NEW;
      END $$;
      DROP TRIGGER IF EXISTS thechat_keep_failed ON pgboss.job;
      CREATE TRIGGER thechat_keep_failed BEFORE INSERT OR UPDATE OF state ON pgboss.job
        FOR EACH ROW EXECUTE FUNCTION public.keep_failed_queue_job();
    `);
  } finally {
    await boss.stop();
  }
}

export function eventQueue(type: string) {
  if (type === "chat.message.sent") return QUEUES.chat;
  if (type.startsWith("attachment.")) return QUEUES.attachments;
  if (type === "bot.request.answered") return QUEUES.answers;
  throw new Error(`No queue for domain event type ${type}`);
}

/** Failed strict-FIFO heads block forever, even if a native DLQ copy exists.
 * Persist our immutable audit and remove the failed head in ONE transaction.
 * A crash before commit leaves the head intact; after commit the audit is durable.
 * The trigger prevents native retention from deleting failures before recovery.
 */
export async function archiveFailedJobs() {
  return db.transaction(async (tx) => {
    const failed = await tx.execute(
      sql`select * from pgboss.job where state='failed' and name in (${sql.join(
        Object.values(QUEUES).map((n) => sql`${n}`),
        sql`,`,
      )}) order by completed_on,id limit 100 for update skip locked`,
    );
    for (const job of failed) {
      await tx.execute(sql`insert into queue_dead_letters(queue,id,data,singleton_key,attempts,error,created_at,dead_at)
        values(${job.name},${job.id},${JSON.stringify(job.data)}::jsonb,${job.singleton_key},${Number(job.retry_count) + 1},${JSON.stringify(job.output)}::jsonb,${job.created_on},${job.completed_on}) on conflict do nothing`);
      await tx.execute(
        sql`delete from pgboss.job where name=${job.name} and id=${job.id} and state='failed'`,
      );
    }
    return failed.length;
  });
}
export async function replayDeadJob(queue: string, id: string) {
  const boss = await getQueueClient();
  return db.transaction(async (tx) => {
    const [dead] = await tx.execute(
      sql`select * from queue_dead_letters where queue=${queue} and id=${id} for update`,
    );
    if (!dead || dead.replay_id) return null;
    const replayId = crypto.randomUUID();
    if (queue === QUEUES.bots) {
      const invocationId = (
        dead.data as { message?: { payload?: { invocationId?: string } } }
      )?.message?.payload?.invocationId;
      if (!invocationId) throw Error("Bot audit has no invocation reference");
      const [invocation] = await tx.execute(
        sql`select status from bot_invocations where id=${invocationId} for update`,
      );
      if (
        !invocation ||
        ["completed", "cancelled", "claimed"].includes(
          String(invocation.status),
        )
      )
        throw Error(
          "Invocation is missing, revoked or already delivered; replay refused",
        );
      await tx.execute(
        sql`update bot_invocations set status='queued',error=null,started_at=null,completed_at=null,updated_at=now() where id=${invocationId} and status='failed'`,
      );
    }
    await boss.send(queue, dead.data as object, {
      id: replayId,
      ...(dead.singleton_key
        ? { singletonKey: String(dead.singleton_key) }
        : {}),
      db: fromDrizzle(tx, sql),
    });
    await tx.execute(
      sql`update queue_dead_letters set replay_id=${replayId},replayed_at=now() where queue=${queue} and id=${id}`,
    );
    return replayId;
  });
}
export async function pendingChatJobs(
  tx: Executor,
  conversationId: string,
  threadId?: string,
) {
  return tx.execute(sql`select id from pgboss.job where name=${QUEUES.chat} and singleton_key=${conversationId}
    and state in ('created','retry','active')
    and jsonb_typeof(data->'payload'->'targetBotIds')='array'
    and jsonb_array_length(data->'payload'->'targetBotIds') > 0
    ${threadId ? sql`and data->'payload'->>'messageId' in (select id::text from messages where thread_id=${threadId})` : sql``}
    limit 1`);
}
export type QueueJob<T = object> = JobWithMetadata<T>;

export function observeDeadLetters() {
  const meter = metrics.getMeter("thechat-queue");
  const gauge = meter.createObservableGauge("thechat.queue.dead_letters", {
    description: "Unreplayed durable dead-letter audits",
    unit: "{job}",
  });
  const age = meter.createObservableGauge("thechat.queue.oldest_ready_age", {
    description: "Age since enqueue of the oldest runnable waiting job",
    unit: "s",
  });
  const callback = async (result: ObservableResult) => {
    const rows = await db.execute(
      sql`select queue,count(*)::int as count from queue_dead_letters where replay_id is null group by queue`,
    );
    for (const queue of Object.values(QUEUES))
      result.observe(Number(rows.find((r) => r.queue === queue)?.count ?? 0), {
        "messaging.destination.name": queue,
      });
  };
  const observeAge = async (result: ObservableResult) => {
    const rows = await db.execute(
      sql`select name,max(extract(epoch from now()-created_on)) as age from pgboss.job where state in ('created','retry') and start_after<=now() group by name`,
    );
    for (const queue of Object.values(QUEUES))
      result.observe(
        Math.max(0, Number(rows.find((r) => r.name === queue)?.age ?? 0)),
        { "messaging.destination.name": queue },
      );
  };
  gauge.addCallback(callback);
  age.addCallback(observeAge);
  return () => {
    gauge.removeCallback(callback);
    age.removeCallback(observeAge);
  };
}
