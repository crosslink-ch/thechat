import { test, expect } from "bun:test";
import { db } from "../db";
import { PgBossAsyncBus, queueJobId } from "./pg-boss";
import { getQueueClient, QUEUES } from "./queue";
import { AsyncWorkerRuntime } from "./worker";

test("transactional bot dispatch rolls back, deduplicates, and runs on the real worker", async () => {
  const bus = new PgBossAsyncBus();
  const boss = await getQueueClient();
  const worker = new AsyncWorkerRuntime({ concurrency: 2 });
  const key = crypto.randomUUID();
  let handled = 0;
  worker.register({
    queue: "thechat:bots",
    name: "test.echo",
    async handle(job, ctx) {
      expect(ctx.signal).toBeInstanceOf(AbortSignal);
      expect(job.message.payload).toEqual({ value: key });
      handled++;
    },
  });
  const command = {
    queue: "thechat:bots",
    name: "test.echo",
    jobId: key,
    message: {
      id: crypto.randomUUID(),
      type: "test.echo",
      version: 1,
      aggregate: { type: "test", id: key },
      correlationId: key,
      occurredAt: new Date().toISOString(),
      payload: { value: key },
    },
  };
  await expect(
    db.transaction(async (tx) => {
      await bus.enqueue(command, tx);
      throw Error("rollback");
    }),
  ).rejects.toThrow("rollback");
  expect(await boss.findJobs(QUEUES.bots, { id: queueJobId(key) })).toEqual([]);
  await db.transaction(async (tx) => {
    await bus.enqueue(command, tx);
    await bus.enqueue(command, tx);
  });
  expect(
    await boss.findJobs(QUEUES.bots, { id: queueJobId(key) }),
  ).toHaveLength(1);
  await worker.start(["thechat:bots"]);
  try {
    const end = Date.now() + 5000;
    while (handled < 1 && Date.now() < end) await Bun.sleep(10);
    expect(handled).toBe(1);
  } finally {
    await worker.close();
    await boss.deleteJob(QUEUES.bots, queueJobId(key));
  }
});
