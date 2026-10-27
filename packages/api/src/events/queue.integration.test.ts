import { describe, test, expect } from "bun:test";
import { sql } from "drizzle-orm";
import { db } from "../db";
import { enqueueDomainEvent } from "./outbox";
import { createChatMessageSentV1 } from "./envelope";
import {
  getQueueClient,
  QUEUES,
  archiveFailedJobs,
  replayDeadJob,
  queueDatabase,
  normalizeResults,
} from "../async/queue";

test("eight attempts, poison quarantine unblocks only its key, audit survives and replay is once", async () => {
  const boss = await getQueueClient();
  const key = crypto.randomUUID();
  const id = (await boss.send(
    QUEUES.chat,
    { test: "poison" },
    { singletonKey: key, retryLimit: 7, retryDelay: 0, retryBackoff: false },
  ))!;
  const follower = (await boss.send(
    QUEUES.chat,
    { test: "follower" },
    { singletonKey: key },
  ))!;
  for (let attempt = 0; attempt < 8; attempt++) {
    const jobs = await boss.fetch(QUEUES.chat, {
      includeMetadata: true,
      batchSize: 100,
    });
    const poison = jobs.find((j) => j.id === id)!;
    expect(poison).toBeDefined();
    expect(poison.retryCount).toBe(attempt);
    expect(jobs.some((j) => j.id === follower)).toBe(false);
    await boss.fail(QUEUES.chat, poison, { errorType: "SyntheticPoison" });
  }
  expect((await boss.findJobs(QUEUES.chat, { id }))[0].state).toBe("failed");
  expect(
    (await boss.fetch(QUEUES.chat, { batchSize: 100 })).some(
      (j) => j.id === follower,
    ),
  ).toBe(false);
  await archiveFailedJobs();
  expect(await boss.findJobs(QUEUES.chat, { id })).toEqual([]);
  const [audit] = await db.execute(
    sql`select * from queue_dead_letters where id=${id}`,
  );
  expect(audit.attempts).toBe(8);
  const next = (await boss.fetch(QUEUES.chat, { batchSize: 100 })).find(
    (j) => j.id === follower,
  )!;
  expect(next).toBeDefined();
  await boss.complete(QUEUES.chat, next);
  const replay = await replayDeadJob(QUEUES.chat, id);
  expect(replay).toBeString();
  expect(await replayDeadJob(QUEUES.chat, id)).toBeNull();
  expect(
    (await db.execute(sql`select * from queue_dead_letters where id=${id}`))
      .length,
  ).toBe(1);
  await boss.deleteJob(QUEUES.chat, [follower, replay!]);
  await db.execute(sql`delete from queue_dead_letters where id=${id}`);
});

test("shared postgres-js adapter preserves single and multi-statement result shapes", async () => {
  expect(
    (await queueDatabase.executeSql("select 1 as n; select 2 as n")).rows,
  ).toEqual([{ n: 1 }, { n: 2 }]);
  expect(
    (
      await queueDatabase.executeSql("select $1::jsonb as payload", [
        { safe: "fixture" },
      ])
    ).rows,
  ).toEqual([{ payload: { safe: "fixture" } }]);
  expect(
    normalizeResults([{ rows: [{ n: 1 }] }, { rows: [{ n: 2 }] }]).rows,
  ).toEqual([{ n: 1 }, { n: 2 }]);
});

describe("pg-boss transactional enqueue", () => {
  test("business write and durable job commit together; rollback leaves neither", async () => {
    const event = createChatMessageSentV1({
      messageId: crypto.randomUUID(),
      conversationId: crypto.randomUUID(),
      senderId: crypto.randomUUID(),
      senderType: "human",
      targetBotIds: [],
      automationDepth: 0,
      messageKind: "user",
    });
    await db.transaction(async (tx) => {
      await enqueueDomainEvent(tx, event, { partitionKey: event.aggregate.id });
    });
    const rows = await db.execute(
      sql`select id from pgboss.job where id=${event.id}`,
    );
    expect(rows.length).toBe(1);
    const rollback = { ...event, id: crypto.randomUUID() };
    await expect(
      db.transaction(async (tx) => {
        await enqueueDomainEvent(tx, rollback, {
          partitionKey: event.aggregate.id,
        });
        throw Error("abort business");
      }),
    ).rejects.toThrow("abort business");
    expect(
      (await db.execute(sql`select id from pgboss.job where id=${rollback.id}`))
        .length,
    ).toBe(0);
    await db.execute(sql`delete from pgboss.job where id=${event.id}`);
  });
});
