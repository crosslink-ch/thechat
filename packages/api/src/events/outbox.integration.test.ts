import { test, expect } from "bun:test";
import { sql } from "drizzle-orm";
import { db } from "../db";
import {
  createQueueClient,
  getQueueClient,
  QUEUES,
  archiveFailedJobs,
} from "../async/queue";

test("two replicas preserve per-key FIFO and fence stale acknowledgements after crash recovery", async () => {
  const a = createQueueClient(),
    b = createQueueClient();
  await a.start();
  await b.start();
  const name = `test.fifo.${crypto.randomUUID()}`;
  await a.createQueue(name, {
    policy: "key_strict_fifo",
    heartbeatSeconds: 10,
    retryLimit: 7,
    retryDelay: 0,
  });
  try {
    const first = (await a.send(name, { n: 1 }, { singletonKey: "a" }))!;
    const second = (await a.send(name, { n: 2 }, { singletonKey: "a" }))!;
    const other = (await a.send(name, { n: 3 }, { singletonKey: "b" }))!;
    const batches = await Promise.all([
      a.fetch(name, { includeMetadata: true, batchSize: 10 }),
      b.fetch(name, { includeMetadata: true, batchSize: 10 }),
    ]);
    const jobs = batches.flat();
    expect(jobs.map((j) => j.id).sort()).toEqual([first, other].sort());
    const stale = jobs.find((j) => j.id === first)!;
    await db.execute(
      sql`update pgboss.job set heartbeat_on=now()-interval '1 hour' where name=${name} and id=${first}`,
    );
    await b.supervise(name);
    const [replacement] = await b.fetch(name, { includeMetadata: true });
    expect(replacement.id).toBe(first);
    expect(replacement.retryCount).toBe(1);
    await a.complete(name, stale);
    await a.fail(name, stale);
    await a.touch(name, stale);
    const [stillOwned] = await b.findJobs(name, { id: first });
    expect(stillOwned.state).toBe("active");
    expect(stillOwned.retryCount).toBe(1);
    expect((await b.findJobs(name, { id: other }))[0].state).toBe("active");
    await b.complete(name, replacement);
    expect((await a.fetch(name))[0].id).toBe(second);
  } finally {
    await a.deleteQueue(name);
    await Promise.all([a.stop(), b.stop()]);
  }
});

test("native FIFO defers initially scheduled jobs but blocks siblings behind a retry", async () => {
  const boss = await getQueueClient();
  const name = `test.scheduled.${crypto.randomUUID()}`;
  await boss.createQueue(name, {
    policy: "key_strict_fifo",
    retryLimit: 1,
    retryDelay: 60,
    retryBackoff: false,
  });
  try {
    const future = (await boss.send(
      name,
      { n: 1 },
      { singletonKey: "key", startAfter: 60 },
    ))!;
    const ready = (await boss.send(name, { n: 2 }, { singletonKey: "key" }))!;
    const [head] = await boss.fetch(name, { includeMetadata: true });
    expect(head.id).toBe(ready);
    await boss.fail(name, head);
    // Make the initially deferred sibling due. The failed head still owns the key.
    await db.execute(
      sql`update pgboss.job set start_after=now() where name=${name} and id=${future}`,
    );
    expect(await boss.fetch(name)).toEqual([]);
    await db.execute(
      sql`update pgboss.job set start_after=now() where name=${name} and id=${ready}`,
    );
    const [retry] = await boss.fetch(name, { includeMetadata: true });
    expect(retry.id).toBe(ready);
    await boss.complete(name, retry);
    expect((await boss.fetch(name))[0].id).toBe(future);
  } finally {
    await boss.deleteQueue(name);
  }
});

test("failed audit write rolls back head removal; native retention keeps failures", async () => {
  const boss = await getQueueClient();
  const key = crypto.randomUUID();
  const id = (await boss.send(
    QUEUES.chat,
    { test: "audit-crash" },
    { singletonKey: key, retryLimit: 0, deleteAfterSeconds: 1 },
  ))!;
  const [job] = (
    await boss.fetch(QUEUES.chat, { includeMetadata: true, batchSize: 1000 })
  ).filter((j) => j.id === id);
  await boss.fail(QUEUES.chat, job);
  await db.execute(
    sql`update pgboss.job set completed_on=now()-interval '2 years' where id=${id}`,
  );
  await boss.supervise(QUEUES.chat);
  expect((await boss.findJobs(QUEUES.chat, { id }))[0].state).toBe("failed");
  // Simulate audit storage failure without changing the queue implementation.
  await db.execute(
    sql`create or replace function public.test_reject_audit() returns trigger language plpgsql as $$ begin raise exception 'synthetic audit unavailable'; end $$`,
  );
  await db.execute(
    sql`create trigger test_reject_audit before insert on queue_dead_letters for each row execute function public.test_reject_audit()`,
  );
  try {
    await expect(archiveFailedJobs()).rejects.toThrow();
    expect((await boss.findJobs(QUEUES.chat, { id }))[0].state).toBe("failed");
  } finally {
    await db.execute(sql`drop trigger test_reject_audit on queue_dead_letters`);
    await db.execute(sql`drop function public.test_reject_audit()`);
  }
  await archiveFailedJobs();
  expect(
    (await db.execute(sql`select id from queue_dead_letters where id=${id}`))
      .length,
  ).toBe(1);
  expect(await boss.findJobs(QUEUES.chat, { id })).toEqual([]);
  await db.execute(sql`delete from queue_dead_letters where id=${id}`);
});

test("native retention removes old completed jobs but not recent successes or pending work", async () => {
  const boss = await getQueueClient();
  const name = `test.retention.${crypto.randomUUID()}`;
  await boss.createQueue(name, { deleteAfterSeconds: 1 });
  try {
    const old = (await boss.send(name, {}))!;
    const recent = (await boss.send(name, {}))!;
    const batch = await boss.fetch(name, { batchSize: 2 });
    await boss.complete(name, batch);
    await db.execute(
      sql`update pgboss.job set completed_on=now()-interval '1 day' where name=${name} and id=${old}`,
    );
    const pending = (await boss.send(name, {}))!;
    await boss.supervise(name);
    expect(await boss.findJobs(name, { id: old })).toEqual([]);
    expect((await boss.findJobs(name, { id: recent }))[0].state).toBe(
      "completed",
    );
    expect((await boss.findJobs(name, { id: pending }))[0].state).toBe(
      "created",
    );
  } finally {
    await boss.deleteQueue(name);
  }
});
