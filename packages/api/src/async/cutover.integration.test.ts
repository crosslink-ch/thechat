import { test, expect } from "bun:test";
import { Queue, Worker } from "bullmq";
import { sql, inArray } from "drizzle-orm";
import { db } from "../db";
import { eventOutbox } from "../db/schema";
import { cutoverLegacyQueues } from "./cutover";
import { getQueueClient, QUEUES } from "./queue";
import { queueJobId } from "./pg-boss";
import { toBullMqQueueName } from "./transport";

test("imports every page from multiple BullMQ states without skipping records", async () => {
  const prefix = `test-cutover-pages-${crypto.randomUUID()}`;
  const queue = new Queue(toBullMqQueueName("thechat:bots"), {
    prefix,
    connection: { url: process.env.REDIS_URL! },
  });
  const ids = Array.from({ length: 302 }, () => crypto.randomUUID());
  const jobIds = ids.map((id) => queueJobId(`bot:invoke:${id}`));
  try {
    await queue.addBulk(
      ids.map((id, i) => ({
        name: "bot.invoke",
        data: {
          id,
          version: 1,
          type: "bot.invoke.requested",
          payload: { invocationId: id },
        },
        opts: { jobId: id, ...(i >= 151 ? { delay: 60000 } : {}) },
      })),
    );
    const result = await cutoverLegacyQueues({ stopped: true, prefix });
    expect(result.botPending).toBe(302);
    const receipts = await db.execute(
      sql`select job_id from queue_legacy_imports where job_id in (${sql.join(
        jobIds.map((id) => sql`${id}::uuid`),
        sql`,`,
      )})`,
    );
    expect(new Set(receipts.map((r) => r.job_id)).size).toBe(302);
  } finally {
    await queue.obliterate({ force: true });
    await queue.close();
    await (await getQueueClient()).deleteJob(QUEUES.bots, jobIds);
    await db.execute(
      sql`delete from queue_legacy_imports where job_id in (${sql.join(
        jobIds.map((id) => sql`${id}::uuid`),
        sql`,`,
      )})`,
    );
    await db.execute(
      sql`drop trigger if exists thechat_legacy_frozen on event_outbox`,
    );
  }
});

test("stopped-world legacy import retains pending and failed work, freezes old writes and is resumable after destination retention", async () => {
  await expect(cutoverLegacyQueues({ stopped: false })).rejects.toThrow(
    "Stop ALL",
  );
  const prefix = `test-cutover-${crypto.randomUUID()}`;
  const name = toBullMqQueueName("thechat:bots");
  const connection = { url: process.env.REDIS_URL! };
  const q = new Queue(name, { prefix, connection });
  const boss = await getQueueClient();
  const pending = crypto.randomUUID(),
    dead = crypto.randomUUID(),
    invocation = crypto.randomUUID(),
    failedInvocation = crypto.randomUUID();
  const payload = (id: string) => ({
    id: crypto.randomUUID(),
    type: "bot.invoke.requested",
    version: 1,
    aggregate: { type: "bot_invocation", id },
    correlationId: id,
    occurredAt: new Date().toISOString(),
    payload: { invocationId: id },
  });
  const oldEvent = (id: string) => ({
    id,
    type: QUEUES.chat,
    version: 1,
    aggregate: { type: "message", id },
    occurredAt: new Date().toISOString(),
    payload: { targetBotIds: [] },
  });
  let worker: Worker | undefined;
  try {
    await db.execute(
      sql`drop trigger if exists thechat_legacy_frozen on event_outbox`,
    );
    for (const id of [pending, dead])
      await db.insert(eventOutbox).values({
        id,
        eventType: QUEUES.chat,
        eventVersion: 1,
        aggregateType: "message",
        aggregateId: id,
        partitionKey: pending,
        event: oldEvent(id),
        ...(id === dead
          ? { deadAt: new Date(), attempts: 25 }
          : { attempts: 2, availableAt: new Date(Date.now() + 60_000) }),
      });
    await q.add("bot.invoke", payload(failedInvocation), {
      jobId: `failed-${failedInvocation}`,
      attempts: 1,
    });
    worker = new Worker<any, any, string>(
      name,
      async () => {
        throw Error("legacy fixture failure");
      },
      { prefix, connection },
    );
    const end = Date.now() + 5000;
    while ((await q.getFailedCount()) !== 1 && Date.now() < end)
      await Bun.sleep(10);
    await worker.close();
    worker = undefined;
    expect(await q.getFailedCount()).toBe(1);
    await q.add("bot.invoke", payload(invocation), {
      jobId: `bot__invoke__${invocation}`,
      delay: 60_000,
      attempts: 3,
    });
    const first = await cutoverLegacyQueues({ stopped: true, prefix });
    expect(first.outboxPending).toBeGreaterThanOrEqual(1);
    expect(first.outboxFailed).toBeGreaterThanOrEqual(1);
    expect(first.botPending).toBe(1);
    expect(first.botFailed).toBe(1);
    expect(await q.isPaused()).toBe(true);
    expect(await q.getDelayedCount()).toBe(1);
    expect(await q.getFailedCount()).toBe(1);
    expect(
      (await boss.findJobs(QUEUES.chat, { id: pending }))[0].singletonKey,
    ).toBe(pending);
    const importedRetry = (
      await boss.findJobs(QUEUES.chat, { id: pending })
    )[0];
    expect(importedRetry.state).toBe("retry");
    // The next native retry claim increments this to 2 (the third attempt).
    expect(importedRetry.retryCount).toBe(1);
    const botId = queueJobId(`bot:invoke:${invocation}`);
    expect(await boss.findJobs(QUEUES.bots, { id: botId })).toHaveLength(1);
    expect(
      (
        await db.execute(
          sql`select id from queue_dead_letters where id=${dead}`,
        )
      ).length,
    ).toBe(1);
    expect(
      (
        await db.execute(
          sql`select id from queue_dead_letters where id=${queueJobId(`bot:invoke:${failedInvocation}`)}`,
        )
      ).length,
    ).toBe(1);
    await expect(
      db
        .insert(eventOutbox)
        .values({
          id: crypto.randomUUID(),
          eventType: QUEUES.chat,
          eventVersion: 1,
          aggregateType: "message",
          aggregateId: pending,
          partitionKey: pending,
          event: oldEvent(pending),
        })
        .execute(),
    ).rejects.toThrow();
    await boss.deleteJob(QUEUES.chat, pending);
    await boss.deleteJob(QUEUES.bots, botId);
    expect(await cutoverLegacyQueues({ stopped: true, prefix })).toEqual({
      outboxPending: 0,
      outboxFailed: 0,
      botPending: 0,
      botFailed: 0,
      reconciledInvocations: 0,
    });
    expect(await boss.findJobs(QUEUES.chat, { id: pending })).toEqual([]);
    expect(await boss.findJobs(QUEUES.bots, { id: botId })).toEqual([]);
    expect(
      (
        await db
          .select()
          .from(eventOutbox)
          .where(inArray(eventOutbox.id, [pending, dead]))
      ).length,
    ).toBe(2);
  } finally {
    await worker?.close(true);
    await boss.deleteJob(QUEUES.chat, pending);
    await boss.deleteJob(QUEUES.bots, queueJobId(`bot:invoke:${invocation}`));
    await q.obliterate({ force: true });
    await q.close();
    await db.execute(
      sql`drop trigger if exists thechat_legacy_frozen on event_outbox`,
    );
    await db
      .delete(eventOutbox)
      .where(inArray(eventOutbox.id, [pending, dead]));
    await db.execute(
      sql`delete from queue_dead_letters where id in (${pending},${dead},${queueJobId(`bot:invoke:${failedInvocation}`)})`,
    );
    await db.execute(
      sql`delete from queue_legacy_imports where id in (${pending},${dead},${`failed-${failedInvocation}`},${`bot__invoke__${invocation}`})`,
    );
  }
});
