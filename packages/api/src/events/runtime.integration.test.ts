import { test, expect } from "bun:test";
import { sql } from "drizzle-orm";
import { db } from "../db";
import { DomainEventRuntime } from "./runtime";
import { DomainEventRegistry, PermanentDomainEventError } from "./registry";
import { parseDomainEventEnvelope } from "./envelope";
import { getQueueClient, createQueueClient, QUEUES } from "../async/queue";
import { runQueueDlqCommand } from "../scripts/outbox-dlq";
const envelope = (type: string) => ({
  id: crypto.randomUUID(),
  type,
  version: 1,
  aggregate: { type: "test", id: crypto.randomUUID() },
  occurredAt: new Date().toISOString(),
  payload: {},
});
async function waitFor(
  check: () => Promise<boolean> | boolean,
  timeout = 6000,
) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await Bun.sleep(10);
  }
  throw Error("Queue condition timed out");
}

test("slow attachment and slow chat do not hold free slots or independent queues; ack follows effect", async () => {
  const boss = await getQueueClient();
  const slow = envelope("attachment.test");
  const chat = envelope(QUEUES.chat);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const started = new Set<string>();
  const registry = new DomainEventRegistry()
    .register({
      type: slow.type,
      version: 1,
      lane: "attachments",
      parse: parseDomainEventEnvelope,
      async handle(e) {
        if (e.id === slow.id) {
          started.add(e.id);
          await gate;
        }
      },
    })
    .register({
      type: chat.type,
      version: 1,
      parse: parseDomainEventEnvelope,
      async handle(e) {
        started.add(e.id);
        if (e.id === chat.id) await gate;
      },
    });
  const runtime = new DomainEventRuntime({
    registry,
    config: { batchSize: 2, attachmentConcurrency: 1 },
  });
  await runtime.start();
  const fast = envelope(QUEUES.chat);
  try {
    await boss.send(QUEUES.attachments, slow, { id: slow.id, priority: 100 });
    await waitFor(() => started.has(slow.id));
    await boss.send(QUEUES.chat, chat, { id: chat.id, singletonKey: chat.id });
    await waitFor(() => started.has(chat.id));
    await boss.send(QUEUES.chat, fast, { id: fast.id, singletonKey: fast.id });
    await waitFor(
      async () =>
        (await boss.findJobs(QUEUES.chat, { id: fast.id }))[0]?.state ===
        "completed",
      1800,
    );
    expect((await boss.findJobs(QUEUES.chat, { id: chat.id }))[0].state).toBe(
      "active",
    );
    expect(
      (await boss.findJobs(QUEUES.attachments, { id: slow.id }))[0].state,
    ).toBe("active");
    release();
    await waitFor(
      async () =>
        (await boss.findJobs(QUEUES.chat, { id: chat.id }))[0].state ===
        "completed",
    );
  } finally {
    release();
    await runtime.close();
    await boss.deleteJob(QUEUES.chat, [chat.id, fast.id]);
    await boss.deleteJob(QUEUES.attachments, slow.id);
  }
});

test("permanent poison is audited once and operator replay retains the original audit", async () => {
  const boss = await getQueueClient();
  const item = envelope(QUEUES.chat);
  let fail = true;
  const registry = new DomainEventRegistry().register({
    type: item.type,
    version: 1,
    parse: parseDomainEventEnvelope,
    async handle(e) {
      if (e.id === item.id && fail)
        throw new PermanentDomainEventError("synthetic");
    },
  });
  const runtime = new DomainEventRuntime({ registry });
  await runtime.start();
  let replayId: string | undefined;
  try {
    await boss.send(QUEUES.chat, item, { id: item.id, singletonKey: item.id });
    await waitFor(
      async () =>
        (
          await db.execute(
            sql`select id from queue_dead_letters where id=${item.id}`,
          )
        ).length === 1,
    );
    const [audit] = await db.execute(
      sql`select attempts from queue_dead_letters where id=${item.id}`,
    );
    expect(audit.attempts).toBe(1);
    fail = false;
    const output: string[] = [];
    expect(
      await runQueueDlqCommand(["replay", QUEUES.chat, item.id], (s) =>
        output.push(s),
      ),
    ).toBe(0);
    replayId = JSON.parse(output[0]).replayId;
    await waitFor(
      async () =>
        (await boss.findJobs(QUEUES.chat, { id: replayId }))[0]?.state ===
        "completed",
    );
    expect(
      await runQueueDlqCommand(["replay", QUEUES.chat, item.id], () => {}),
    ).toBe(1);
    expect(await runQueueDlqCommand(["replay"], () => {})).toBe(2);
  } finally {
    await runtime.close();
    if (replayId) await boss.deleteJob(QUEUES.chat, replayId);
    await db.execute(sql`delete from queue_dead_letters where id=${item.id}`);
  }
});

test("heartbeats protect a legitimate long handler across replicas; shutdown aborts and retries", async () => {
  const a = createQueueClient(),
    b = createQueueClient();
  await a.start();
  await b.start();
  const name = `test.heartbeat.${crypto.randomUUID()}`;
  await a.createQueue(name, {
    heartbeatSeconds: 10,
    expireInSeconds: 60,
    retryLimit: 2,
    retryDelay: 0,
  });
  let starts = 0,
    aborted = false;
  await a.work(
    name,
    { heartbeatRefreshSeconds: 2, pollingIntervalSeconds: 0.5 },
    async ([job]) => {
      starts++;
      await new Promise<void>((_r, reject) =>
        job.signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(job.signal.reason);
          },
          { once: true },
        ),
      );
    },
  );
  const id = (await a.send(name, {}))!;
  try {
    await waitFor(() => starts === 1);
    await Bun.sleep(11_000);
    await b.supervise(name);
    expect(await b.fetch(name)).toEqual([]);
    expect(starts).toBe(1);
    const before = Date.now();
    await a.stop({ graceful: true, timeout: 1000 });
    expect(Date.now() - before).toBeLessThan(4000);
    expect(aborted).toBe(true);
    const [retry] = await b.fetch(name, { includeMetadata: true });
    expect(retry.id).toBe(id);
    expect(retry.retryCount).toBe(1);
    await b.complete(name, retry);
  } finally {
    await a.stop();
    await b.deleteQueue(name);
    await b.stop();
  }
});

test("expiry aborts cooperative work, records failure and releases its slot", async () => {
  const boss = createQueueClient();
  await boss.start();
  const name = `test.expiry.${crypto.randomUUID()}`;
  await boss.createQueue(name, { expireInSeconds: 1, retryLimit: 0 });
  let aborted = false,
    finished = 0;
  await boss.work<{ slow: boolean }>(
    name,
    { pollingIntervalSeconds: 0.5 },
    async ([job]) => {
      if (job.data.slow)
        await new Promise<void>((_r, reject) =>
          job.signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(job.signal.reason);
            },
            { once: true },
          ),
        );
      else finished++;
    },
  );
  try {
    const id = await boss.send(name, { slow: true });
    await boss.send(name, { slow: false });
    await waitFor(() => finished === 1);
    expect(aborted).toBe(true);
    expect((await boss.findJobs(name, { id: id! }))[0].state).toBe("failed");
  } finally {
    await boss.stop();
    await (await getQueueClient()).deleteQueue(name);
  }
});
