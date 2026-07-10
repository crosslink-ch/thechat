import { afterAll, describe, expect, test } from "bun:test";
import crypto from "crypto";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { eventOutbox } from "../db/schema";
import { parseDomainEventEnvelope } from "./envelope";
import { enqueueDomainEvent } from "./outbox";
import {
  DomainEventRegistry,
  PermanentDomainEventError,
} from "./registry";
import { DomainEventRuntime } from "./runtime";

const ids: string[] = [];

afterAll(async () => {
  if (ids.length > 0) {
    await db.delete(eventOutbox).where(inArray(eventOutbox.id, ids));
  }
});

describe("PostgreSQL domain-event runtime", () => {
  test("drains an outbox row directly and acknowledges it only after the handler succeeds", async () => {
    const item = event("test.runtime.success");
    ids.push(item.id);
    const handled: string[] = [];
    const registry = new DomainEventRegistry().register({
      type: "test.runtime.success",
      version: 1,
      parse: parseDomainEventEnvelope,
      async handle(value) {
        handled.push(value.id);
      },
    });
    const runtime = new DomainEventRuntime({
      registry,
      workerId: `runtime-test-${crypto.randomUUID()}`,
      config: testConfig(),
    });

    await enqueueDomainEvent(db, item, { partitionKey: `runtime-${item.id}` });
    try {
      await runtime.start();
      await waitFor(async () => {
        const [row] = await db
          .select({ publishedAt: eventOutbox.publishedAt })
          .from(eventOutbox)
          .where(eq(eventOutbox.id, item.id));
        return row?.publishedAt ? true : false;
      });
    } finally {
      await runtime.close();
    }

    expect(handled).toEqual([item.id]);
  });

  test("quarantines permanent handler failures without retrying", async () => {
    const item = event("test.runtime.permanent");
    ids.push(item.id);
    const registry = new DomainEventRegistry().register({
      type: "test.runtime.permanent",
      version: 1,
      parse: parseDomainEventEnvelope,
      async handle() {
        throw new PermanentDomainEventError("invalid domain state");
      },
    });
    const runtime = new DomainEventRuntime({
      registry,
      workerId: `runtime-test-${crypto.randomUUID()}`,
      config: testConfig(),
    });

    await enqueueDomainEvent(db, item, { partitionKey: `runtime-${item.id}` });
    try {
      await runtime.start();
      await waitFor(async () => {
        const [row] = await db
          .select({ attempts: eventOutbox.attempts, deadAt: eventOutbox.deadAt })
          .from(eventOutbox)
          .where(eq(eventOutbox.id, item.id));
        return row?.deadAt && row.attempts === 1 ? true : false;
      });
    } finally {
      await runtime.close();
    }
  });
});

function testConfig() {
  return {
    batchSize: 10,
    pollIntervalMs: 5,
    lockTimeoutMs: 30_000,
    maxAttempts: 3,
    retentionDays: 36_500,
    pruneIntervalMs: 86_400_000,
    pruneBatchSize: 10,
  };
}

function event(type: string) {
  return parseDomainEventEnvelope({
    id: crypto.randomUUID(),
    type,
    version: 1,
    aggregate: { type: "test", id: crypto.randomUUID() },
    occurredAt: new Date().toISOString(),
    payload: {},
  });
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(10);
  }
  throw new Error("Timed out waiting for outbox runtime result");
}
