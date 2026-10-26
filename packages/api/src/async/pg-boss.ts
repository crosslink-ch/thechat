import crypto from "node:crypto";
import { sql } from "drizzle-orm";
import { fromDrizzle } from "pg-boss";
import { activeTraceContext } from "../observability";
import { getQueueClient, QUEUES, type Executor } from "./queue";
import type { QueueCommand, QueuedJob } from "./types";
/** Stable UUID from a logical job key, preserved across cutover and redelivery. */
export function queueJobId(key: string) {
  const h = crypto.createHash("sha256").update(key).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
export class PgBossAsyncBus {
  async enqueue<T>(command: QueueCommand<T>, tx: Executor): Promise<QueuedJob> {
    const boss = await getQueueClient();
    const id = queueJobId(command.jobId);
    // Preserve trace lineage supplied by callers outside an active span too.
    const message = {
      ...command.message,
      traceContext: activeTraceContext() ?? command.message.traceContext,
    };
    const sent = await boss.send(
      QUEUES.bots,
      { name: command.name, message },
      {
        id,
        retryLimit: (command.attempts ?? 8) - 1,
        retryDelay: Math.ceil((command.backoff?.delay ?? 2000) / 1000),
        retryBackoff: true,
        retryDelayMax: 300,
        ...(command.delayMs ? { startAfter: command.delayMs / 1000 } : {}),
        db: fromDrizzle(tx, sql),
      },
    );
    if (
      !sent &&
      !(await boss.findJobs(QUEUES.bots, { id, db: fromDrizzle(tx, sql) }))
        .length
    )
      throw Error("Bot dispatch was not durably inserted");
    return {
      queue: command.queue,
      name: command.name,
      jobId: id,
      messageId: message.id,
    };
  }
}
