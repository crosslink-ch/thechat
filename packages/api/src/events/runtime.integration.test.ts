import { afterAll, describe, expect, test } from "bun:test";
import crypto from "crypto";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { eventOutbox } from "../db/schema";
import { parseDomainEventEnvelope } from "./envelope";
import {
  enqueueDomainEvent,
  listDeadOutboxEvents,
  replayDeadOutboxEvents,
} from "./outbox";
import {
  DomainEventRegistry,
  PermanentDomainEventError,
  type DomainEventHandlerContext,
  type DomainEventLane,
} from "./registry";
import { DomainEventRuntime } from "./runtime";
import type { DomainEventsConfig } from "./config";
import { runOutboxDlqCommand } from "../scripts/outbox-dlq";

const ids: string[] = [];
const runtimes: DomainEventRuntime[] = [];

afterAll(async () => {
  await Promise.allSettled(runtimes.map((runtime) => runtime.close()));
  if (ids.length > 0) {
    await db.delete(eventOutbox).where(inArray(eventOutbox.id, ids));
  }
});

describe("PostgreSQL domain-event runtime", () => {
  test("drains an outbox row directly and acknowledges it only after the handler succeeds", async () => {
    const type = uniqueType("success");
    const item = event(type);
    const handled: string[] = [];
    const registry = new DomainEventRegistry().register({
      type,
      version: 1,
      parse: parseDomainEventEnvelope,
      async handle(value) {
        handled.push(value.id);
      },
    });
    const runtime = startRuntime(registry);

    await enqueue(item);
    await waitFor(() => isPublished(item.id));
    await runtime.close();

    expect(handled).toEqual([item.id]);
  });

  test("quarantines permanent handler failures without retrying", async () => {
    const type = uniqueType("permanent");
    const item = event(type);
    const registry = new DomainEventRegistry().register({
      type,
      version: 1,
      parse: parseDomainEventEnvelope,
      async handle() {
        throw new PermanentDomainEventError("invalid domain state");
      },
    });
    const runtime = startRuntime(registry);

    await enqueue(item);
    await waitFor(async () => {
      const row = await outboxRow(item.id);
      return Boolean(row?.deadAt && row.attempts === 1);
    });
    await runtime.close();
  });

  test("claims new work while an earlier event of the same lane is still running", async () => {
    // Regression: the relay used to await the whole claimed batch, so one
    // slow event stopped every later event from being claimed.
    const slowType = uniqueType("slow");
    const fastType = uniqueType("fast");
    const slow = deferred();
    const slowStarted = deferred();
    const registry = new DomainEventRegistry()
      .register(handler(slowType, async () => {
        slowStarted.resolve();
        await slow.promise;
      }))
      .register(handler(fastType, async () => undefined));
    const runtime = startRuntime(registry, { batchSize: 10 });

    const slowItem = event(slowType);
    await enqueue(slowItem);
    await withTimeout(slowStarted.promise, 2_000, "slow handler start");

    const fastItem = event(fastType);
    const enqueuedAt = Date.now();
    await enqueue(fastItem);
    await waitFor(() => isPublished(fastItem.id), 2_000);
    expect(Date.now() - enqueuedAt).toBeLessThan(1_500);
    expect(await isPublished(slowItem.id)).toBe(false);

    slow.resolve();
    await waitFor(() => isPublished(slowItem.id));
    await runtime.close();
  });

  test("a hanging attachment-lane handler never delays default-lane events", async () => {
    const attachmentType = uniqueType("attachment");
    const chatType = uniqueType("chat");
    const startedAttachments: string[] = [];
    const firstAttachmentStarted = deferred();
    const registry = new DomainEventRegistry()
      .register(
        handler(
          attachmentType,
          async (value, context) => {
            startedAttachments.push(value.id);
            firstAttachmentStarted.resolve();
            await untilAborted(context);
          },
          "attachments",
        ),
      )
      .register(handler(chatType, async () => undefined));
    // One attachment slot: both attachment events compete for it, as in the
    // production incident. Chat capacity is separate.
    const runtime = startRuntime(registry, {
      batchSize: 1,
      attachmentConcurrency: 1,
      attachmentHandlerTimeoutMs: 60_000,
    });

    const firstAttachment = event(attachmentType);
    const secondAttachment = event(attachmentType);
    await enqueue(firstAttachment);
    await withTimeout(firstAttachmentStarted.promise, 2_000, "attachment start");
    await enqueue(secondAttachment);

    const chatItems = [event(chatType), event(chatType), event(chatType)];
    const enqueuedAt = Date.now();
    for (const item of chatItems) await enqueue(item);
    for (const item of chatItems) {
      await waitFor(() => isPublished(item.id), 3_000);
    }
    expect(Date.now() - enqueuedAt).toBeLessThan(2_500);

    // The attachment lane stays at its own capacity of one.
    expect(startedAttachments).toEqual([firstAttachment.id]);
    await runtime.close();
  });

  test("a timed-out attempt is retried with a doubled budget, so slow work eventually succeeds", async () => {
    const type = uniqueType("needs-more-time");
    const item = event(type);
    const attempts: Array<{ outcome: string; ms: number }> = [];
    const registry = new DomainEventRegistry().register(
      handler(type, async (_value, context) => {
        const started = Date.now();
        // Needs ~350 ms. The first budget (250 ms) is too short; the retry
        // budget (500 ms) is enough.
        try {
          await sleepUnlessAborted(350, context);
          attempts.push({ outcome: "done", ms: Date.now() - started });
        } catch (error) {
          attempts.push({ outcome: "aborted", ms: Date.now() - started });
          throw error;
        }
      }),
    );
    const runtime = startRuntime(registry, {
      handlerTimeoutMs: 250,
      maxHandlerTimeoutMs: 10_000,
    });

    await enqueue(item);
    await waitFor(() => isPublished(item.id), 6_000);
    await runtime.close();

    expect(attempts.map((attempt) => attempt.outcome)).toEqual([
      "aborted",
      "done",
    ]);
    const row = await outboxRow(item.id);
    expect(row?.attempts).toBe(1);
  });

  test("records a timeout as a failed attempt with an explicit error", async () => {
    const type = uniqueType("timeout");
    const item = event(type);
    const registry = new DomainEventRegistry().register(
      handler(type, async (_value, context) => untilAborted(context)),
    );
    const runtime = startRuntime(registry, {
      handlerTimeoutMs: 150,
      maxAttempts: 1,
    });

    await enqueue(item);
    await waitFor(async () => Boolean((await outboxRow(item.id))?.deadAt), 3_000);
    await runtime.close();

    const row = await outboxRow(item.id);
    expect(row?.attempts).toBe(1);
    expect(row?.lastError).toContain("150 ms attempt budget");
  });

  test("frees the slot of a handler that ignores its abort signal", async () => {
    const stuckType = uniqueType("ignores-abort");
    const nextType = uniqueType("after-stuck");
    const registry = new DomainEventRegistry()
      .register(handler(stuckType, () => new Promise<void>(() => undefined)))
      .register(handler(nextType, async () => undefined));
    const runtime = startRuntime(registry, {
      batchSize: 1,
      handlerTimeoutMs: 150,
      handlerAbortGraceMs: 150,
      maxAttempts: 1,
    });

    const stuck = event(stuckType);
    const next = event(nextType);
    await enqueue(stuck);
    await Bun.sleep(50);
    await enqueue(next);
    await waitFor(() => isPublished(next.id), 3_000);
    await runtime.close();

    const row = await outboxRow(stuck.id);
    expect(row?.deadAt).not.toBeNull();
    expect(row?.lastError).toContain("attempt budget");
  });

  test("renews the lease of a long handler so other workers never take it over", async () => {
    const type = uniqueType("long");
    const item = event(type);
    let starts = 0;
    const registry = new DomainEventRegistry().register(
      handler(type, async (_value, context) => {
        starts += 1;
        await sleepUnlessAborted(1_200, context);
      }),
    );
    const config = { lockTimeoutMs: 300, handlerTimeoutMs: 10_000 };
    const owner = startRuntime(registry, config, "lease-owner");
    await enqueue(item);
    await waitFor(async () => starts === 1, 2_000);
    // A second worker polls throughout; without renewal it would reclaim the
    // row after 300 ms and run the handler again.
    const rival = startRuntime(registry, config, "lease-rival");

    await waitFor(() => isPublished(item.id), 4_000);
    await Promise.all([owner.close(), rival.close()]);
    expect(starts).toBe(1);
    expect((await outboxRow(item.id))?.attempts).toBe(0);
  });

  test("stops a handler whose lease was taken over and leaves the row to the new owner", async () => {
    const type = uniqueType("stolen");
    const item = event(type);
    const started = deferred();
    let abortReason: unknown;
    const registry = new DomainEventRegistry().register(
      handler(type, async (_value, context) => {
        started.resolve();
        try {
          await untilAborted(context);
        } finally {
          abortReason = context?.signal.reason;
        }
      }),
    );
    const runtime = startRuntime(registry, { lockTimeoutMs: 200 });

    await enqueue(item);
    await withTimeout(started.promise, 2_000, "handler start");
    await db
      .update(eventOutbox)
      .set({ lockedBy: "new-owner", lockedAt: new Date() })
      .where(eq(eventOutbox.id, item.id));

    await waitFor(async () => abortReason !== undefined, 2_000);
    await runtime.close();
    expect((abortReason as Error).name).toBe("DomainEventLeaseLostError");
    const row = await outboxRow(item.id);
    expect(row?.lockedBy).toBe("new-owner");
    expect(row?.attempts).toBe(0);
    expect(row?.publishedAt).toBeNull();
  });

  test("hands unfinished events back on shutdown without spending an attempt", async () => {
    const type = uniqueType("shutdown");
    const item = event(type);
    const started = deferred();
    const registry = new DomainEventRegistry().register(
      handler(type, async (_value, context) => {
        started.resolve();
        await untilAborted(context);
      }),
    );
    const runtime = startRuntime(registry, {
      shutdownGraceMs: 100,
      handlerAbortGraceMs: 100,
    });

    await enqueue(item);
    await withTimeout(started.promise, 2_000, "handler start");
    const closing = Date.now();
    await runtime.close();
    expect(Date.now() - closing).toBeLessThan(2_000);

    const row = await outboxRow(item.id);
    expect(row).toMatchObject({
      lockedBy: null,
      lockedAt: null,
      attempts: 0,
      publishedAt: null,
      deadAt: null,
    });

    // Another worker picks it up immediately.
    const finisher = startRuntime(
      new DomainEventRegistry().register(handler(type, async () => undefined)),
    );
    await waitFor(() => isPublished(item.id), 2_000);
    await finisher.close();
  });

  test("replays dead-lettered events through the operator command", async () => {
    const type = uniqueType("dlq");
    const item = event(type);
    let fail = true;
    const registry = new DomainEventRegistry().register(
      handler(type, async () => {
        if (fail) throw new PermanentDomainEventError("downstream rejected it");
      }),
    );
    const runtime = startRuntime(registry);
    await enqueue(item);
    await waitFor(async () => Boolean((await outboxRow(item.id))?.deadAt), 2_000);

    const listed = await listDeadOutboxEvents({ eventType: type });
    expect(listed.map((row) => row.id)).toEqual([item.id]);
    expect(listed[0]?.lastError).toBe("downstream rejected it");

    const output: string[] = [];
    expect(await runOutboxDlqCommand(["list", "--type", type], (line) => output.push(line))).toBe(0);
    expect(JSON.parse(output[0]!)).toMatchObject({ id: item.id, eventType: type });

    fail = false;
    output.length = 0;
    expect(await runOutboxDlqCommand(["replay", item.id], (line) => output.push(line))).toBe(0);
    expect(JSON.parse(output[0]!)).toEqual({ replayed: [item.id], notDead: [] });
    await waitFor(() => isPublished(item.id), 3_000);
    await runtime.close();

    const row = await outboxRow(item.id);
    expect(row?.deadAt).toBeNull();
    expect(row?.attempts).toBe(0);

    // Replaying something that is not dead is reported, not silently ignored.
    output.length = 0;
    expect(await runOutboxDlqCommand(["replay", item.id], (line) => output.push(line))).toBe(1);
    expect(JSON.parse(output[0]!)).toEqual({ replayed: [], notDead: [item.id] });
    await expect(replayDeadOutboxEvents({})).rejects.toThrow("explicit event IDs");
  });
});

type TestEnvelope = ReturnType<typeof parseDomainEventEnvelope>;

function handler(
  type: string,
  handle: (value: TestEnvelope, context?: DomainEventHandlerContext) => Promise<void>,
  lane?: DomainEventLane,
) {
  return {
    type,
    version: 1,
    ...(lane ? { lane } : {}),
    parse: parseDomainEventEnvelope,
    handle,
  };
}

function startRuntime(
  registry: DomainEventRegistry,
  config: Partial<DomainEventsConfig> = {},
  workerId = "runtime-test",
) {
  const runtime = new DomainEventRuntime({
    registry,
    workerId: `${workerId}-${crypto.randomUUID()}`,
    config: { ...testConfig(), ...config },
  });
  runtimes.push(runtime);
  void runtime.start();
  return runtime;
}

function testConfig(): Partial<DomainEventsConfig> {
  return {
    batchSize: 10,
    attachmentConcurrency: 1,
    pollIntervalMs: 5,
    lockTimeoutMs: 30_000,
    handlerTimeoutMs: 30_000,
    attachmentHandlerTimeoutMs: 30_000,
    maxHandlerTimeoutMs: 60_000,
    handlerAbortGraceMs: 1_000,
    shutdownGraceMs: 2_000,
    maxAttempts: 3,
    retentionDays: 36_500,
    pruneIntervalMs: 86_400_000,
    pruneBatchSize: 10,
  };
}

function uniqueType(name: string) {
  return `test.runtime.${name}.${crypto.randomUUID().slice(0, 8)}`;
}

function event(type: string) {
  const item = parseDomainEventEnvelope({
    id: crypto.randomUUID(),
    type,
    version: 1,
    aggregate: { type: "test", id: crypto.randomUUID() },
    occurredAt: new Date().toISOString(),
    payload: {},
  });
  ids.push(item.id);
  return item;
}

async function enqueue(item: TestEnvelope) {
  await enqueueDomainEvent(db, item, { partitionKey: `runtime-${item.id}` });
}

async function outboxRow(id: string) {
  const [row] = await db
    .select({
      attempts: eventOutbox.attempts,
      deadAt: eventOutbox.deadAt,
      publishedAt: eventOutbox.publishedAt,
      lockedBy: eventOutbox.lockedBy,
      lockedAt: eventOutbox.lockedAt,
      lastError: eventOutbox.lastError,
    })
    .from(eventOutbox)
    .where(eq(eventOutbox.id, id));
  return row ?? null;
}

async function isPublished(id: string) {
  return Boolean((await outboxRow(id))?.publishedAt);
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function untilAborted(context: DomainEventHandlerContext | undefined) {
  const signal = context?.signal;
  return new Promise<void>((_resolve, reject) => {
    if (!signal) return;
    if (signal.aborted) return reject(signal.reason);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

function sleepUnlessAborted(ms: number, context: DomainEventHandlerContext | undefined) {
  const signal = context?.signal;
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(10);
  }
  throw new Error("Timed out waiting for outbox runtime result");
}
