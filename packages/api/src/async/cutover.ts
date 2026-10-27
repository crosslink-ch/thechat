import { Queue, type Job } from "bullmq";
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { fromDrizzle } from "pg-boss";
import { db } from "../db";
import {
  eventQueue,
  getQueueClient,
  QUEUES,
  queueConfig,
  type Transaction,
} from "./queue";
import { queueJobId } from "./pg-boss";
import { toBullMqQueueName } from "./transport";
import { parseDomainEventEnvelope } from "../events/envelope";

/** Stopped-world, resumable import. Never removes legacy rows or Redis jobs.
 * PostgreSQL receipts commit with each destination write; reruns cannot enqueue
 * again even after pg-boss has removed a completed job by retention.
 */
export async function cutoverLegacyQueues(options: {
  stopped: boolean;
  redisUrl?: string;
  prefix?: string;
  quarantineActive?: boolean;
}) {
  if (!options.stopped)
    throw Error(
      "Stop ALL old/new API, worker and expiry/cleanup producers, then pass --stopped",
    );
  const boss = await getQueueClient();
  const legacy = new Queue(toBullMqQueueName("thechat:bots"), {
    connection: {
      url:
        options.redisUrl ?? process.env.REDIS_URL ?? "redis://localhost:16380",
    },
    prefix: options.prefix ?? process.env.REDIS_KEY_PREFIX ?? "thechat",
  });
  const summary = {
    outboxPending: 0,
    outboxFailed: 0,
    botPending: 0,
    botFailed: 0,
    reconciledInvocations: 0,
  };
  const legacySource = `bullmq:${legacy.opts.prefix}:${legacy.name}`;
  const snapshot = new Map<string, string>();
  try {
    // Pausing is persistent and idempotent. Do NOT resume this old queue later.
    await legacy.pause();
    if (!(await legacy.isPaused())) throw Error("Legacy queue did not pause");
    const active = await legacy.getActiveCount();
    if (active && !options.quarantineActive)
      throw Error(
        `${active} active legacy jobs: drain before shutdown, or explicitly --quarantine-active after stopping workers`,
      );
    const [workers] = await db.execute(
      sql`select count(*)::int as n from pgboss.instance where stopped_on is null and heartbeat_on > now()-heartbeat_seconds*interval '3 seconds'`,
    );
    if (Number(workers.n) > 0)
      throw Error("Stop all pg-boss workers before cutover");
    // Fence old API/outbox producers at the database. Existing data is not altered.
    await db.execute(
      sql`create or replace function public.reject_legacy_enqueue() returns trigger language plpgsql as $$ begin raise exception 'Legacy outbox is frozen: pg-boss cutover'; end $$`,
    );
    await db.execute(
      sql`drop trigger if exists thechat_legacy_frozen on event_outbox`,
    );
    await db.execute(
      sql`create trigger thechat_legacy_frozen before insert on event_outbox for each row execute function public.reject_legacy_enqueue()`,
    );
    while (true) {
      const count = await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(748149277)`);
        const rows = await tx.execute(
          sql`select o.* from event_outbox o where o.published_at is null and not exists(select 1 from queue_legacy_imports i where i.source='outbox' and i.id=o.id::text) order by o.created_at,o.id limit 100 for update of o`,
        );
        for (const row of rows) {
          const data = parseDomainEventEnvelope(row.event);
          const name = eventQueue(data.type);
          const id = String(row.id);
          const dead =
            Boolean(row.dead_at) ||
            Number(row.attempts) >= queueConfig.retryLimit + 1;
          if (dead) {
            await audit(
              tx,
              name,
              id,
              data,
              name === QUEUES.chat ? String(row.partition_key) : null,
              Number(row.attempts),
              { errorType: "LegacyFailure" },
              row.created_at as Date,
            );
            summary.outboxFailed++;
          } else {
            await boss.send(name, data, {
              id,
              ...(name === QUEUES.chat
                ? { singletonKey: String(row.partition_key) }
                : {}),
              startAfter: new Date(row.available_at as string),
              db: fromDrizzle(tx, sql),
            });
            // Preserve the legacy ordering and already spent retry budget.
            await tx.execute(
              sql`update pgboss.job set created_on=${row.created_at},state=${Number(row.attempts) > 0 ? "retry" : "created"}::pgboss.job_state,retry_count=${Math.max(0, Number(row.attempts) - 1)} where name=${name} and id=${id}`,
            );
            summary.outboxPending++;
          }
          await receipt(tx, "outbox", id, name, id);
        }
        return rows.length;
      });
      if (count === 0) break;
    }
    // A stable, stopped/paused queue is paginated without mutation, including failed jobs.
    let offset = 0;
    const states = [
      "wait",
      "paused",
      "delayed",
      "prioritized",
      "waiting-children",
      "failed",
      "active",
    ] as const;
    while (true) {
      const jobs = await legacy.getJobs([...states], offset, offset + 99, true);
      if (!jobs.length) break;
      for (const job of jobs) {
        if (!job?.id) throw Error("Legacy job disappeared during cutover");
        const state = await job.getState();
        const data = job.data;
        snapshot.set(job.id, fingerprint(job, state));
        const invocationId = data?.payload?.invocationId;
        if (
          typeof invocationId !== "string" ||
          !["bot.invoke", "bot.hermes_webhook.deliver"].includes(job.name)
        )
          throw Error(
            `Unsupported legacy bot job ${job.id}; retained unchanged`,
          );
        const key =
          job.name === "bot.invoke"
            ? `bot:invoke:${invocationId}`
            : `bot:hermes-webhook:${invocationId}`;
        const id = queueJobId(key);
        const name = QUEUES.bots;
        await db.transaction(async (tx) => {
          await tx.execute(sql`select pg_advisory_xact_lock(748149277)`);
          if (
            (
              await tx.execute(
                sql`select id from queue_legacy_imports where source=${legacySource} and id=${String(job.id)}`,
              )
            ).length
          )
            return;
          const payload = { name: job.name, message: data };
          if (state === "failed" || state === "active") {
            await audit(
              tx,
              name,
              id,
              payload,
              null,
              job.attemptsMade,
              {
                errorType:
                  state === "active"
                    ? "LegacyAmbiguousActive"
                    : "LegacyFailure",
              },
              new Date(job.timestamp),
            );
            summary.botFailed++;
          } else {
            await boss.send(name, payload, {
              id,
              startAfter: new Date(
                Math.max(Date.now(), job.timestamp + (job.delay || 0)),
              ),
              retryLimit: Math.max(0, (job.opts.attempts ?? 3) - 1),
              db: fromDrizzle(tx, sql),
            });
            await tx.execute(
              sql`update pgboss.job set retry_count=${job.attemptsMade} where name=${name} and id=${id}`,
            );
            summary.botPending++;
          }
          await receipt(tx, legacySource, String(job.id), name, id);
        });
      }
      // BullMQ applies start/end to EACH state, not the concatenated result.
      offset += 100;
    }
    const verified = new Set<string>();
    for (let page = 0; ; page += 100) {
      const jobs = await legacy.getJobs([...states], page, page + 99, true);
      if (!jobs.length) break;
      for (const job of jobs) {
        if (
          !job?.id ||
          snapshot.get(job.id) !== fingerprint(job, await job.getState())
        )
          throw Error(
            "Legacy Redis inventory changed; keep all consumers stopped and rerun cutover",
          );
        verified.add(job.id);
      }
    }
    if (verified.size !== snapshot.size)
      throw Error("Legacy Redis inventory shrank during cutover");
    // Heal the deployed dual-write gap: a committed invocation may never have reached Redis.
    // Polling-only Hermes remains entirely unchanged. Running orphan executions are ambiguous
    // and audited, NOT automatically redelivered.
    const orphans = await db.execute(
      sql`select i.*,b.kind,b.webhook_url,c.workspace_id from bot_invocations i join bots b on b.id=i.bot_id join conversations c on c.id=i.conversation_id where i.status in ('queued','running') and (b.kind <> 'hermes' or b.webhook_url is not null)`,
    );
    for (const row of orphans) {
      const invocationId = String(row.id),
        hermes = row.kind === "hermes";
      const id = queueJobId(
        hermes
          ? `bot:hermes-webhook:${invocationId}`
          : `bot:invoke:${invocationId}`,
      );
      const name = hermes ? "bot.hermes_webhook.deliver" : "bot.invoke";
      await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(748149277)`);
        if (
          (
            await tx.execute(
              sql`select id from queue_legacy_imports where job_id=${id}`,
            )
          ).length
        )
          return;
        const payload = {
          name,
          message: {
            id: crypto.randomUUID(),
            type: hermes
              ? "bot.hermes_webhook_delivery.requested"
              : "bot.invoke.requested",
            version: 1,
            aggregate: { type: "bot_invocation", id: invocationId },
            correlationId: invocationId,
            occurredAt: new Date(row.created_at as string).toISOString(),
            payload: { invocationId },
          },
        };
        if (row.status === "running")
          await audit(
            tx,
            QUEUES.bots,
            id,
            payload,
            null,
            0,
            { errorType: "LegacyAmbiguousRunning" },
            row.created_at as Date,
          );
        else
          await boss.send(QUEUES.bots, payload, {
            id,
            retryLimit: 2,
            db: fromDrizzle(tx, sql),
          });
        await receipt(tx, "invocation", invocationId, QUEUES.bots, id);
        summary.reconciledInvocations++;
      });
    }
    const remaining = await db.execute(
      sql`select count(*)::int as n from event_outbox o where o.published_at is null and not exists(select 1 from queue_legacy_imports i where i.source='outbox' and i.id=o.id::text)`,
    );
    if (Number(remaining[0].n) !== 0)
      throw Error("Outbox producer was still writing during cutover");
    return summary;
  } finally {
    await legacy.close();
  }
}
function fingerprint(job: Job, state: string) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        job.id,
        job.name,
        job.data,
        job.opts,
        job.attemptsMade,
        job.timestamp,
        job.delay,
        state,
      ]),
    )
    .digest("hex");
}
async function receipt(
  tx: Transaction,
  source: string,
  id: string,
  queue: string,
  jobId: string,
) {
  await tx.execute(
    sql`insert into queue_legacy_imports(source,id,queue,job_id) values(${source},${id},${queue},${jobId}) on conflict do nothing`,
  );
}
async function audit(
  tx: Transaction,
  queue: string,
  id: string,
  data: object,
  key: string | null,
  attempts: number,
  error: object,
  createdAt: Date,
) {
  await tx.execute(
    sql`insert into queue_dead_letters(queue,id,data,singleton_key,attempts,error,created_at) values(${queue},${id},${JSON.stringify(data)}::jsonb,${key},${attempts},${JSON.stringify(error)}::jsonb,${new Date(createdAt).toISOString()}) on conflict do nothing`,
  );
}
