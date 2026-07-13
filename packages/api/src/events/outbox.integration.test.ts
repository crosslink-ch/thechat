import { afterAll, describe, expect, test } from "bun:test";
import crypto from "crypto";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { eventOutbox } from "../db/schema";
import { parseDomainEventEnvelope } from "./envelope";
import {
  claimOutboxEvents,
  enqueueDomainEvent,
  markOutboxEventPublished,
  prunePublishedOutboxEvents,
  releaseOutboxEvent,
} from "./outbox";

const ids: string[] = [];

afterAll(async () => {
  if (ids.length > 0) {
    await db.delete(eventOutbox).where(inArray(eventOutbox.id, ids));
  }
});

describe("transactional outbox claiming", () => {
  test("reclaims stale leases, preserves fresh leases, and reschedules a transient failure", async () => {
    const now = new Date("2000-01-01T00:00:00.000Z");
    const staleEvent = event(crypto.randomUUID(), "stale");
    const freshEvent = event(crypto.randomUUID(), "fresh");
    await enqueueDomainEvent(db, staleEvent, {
      partitionKey: "conversation-stale",
      availableAt: new Date("1999-12-31T23:00:00.000Z"),
    });
    await enqueueDomainEvent(db, freshEvent, {
      partitionKey: "conversation-fresh",
      availableAt: new Date("1999-12-31T23:00:00.000Z"),
    });
    ids.push(staleEvent.id, freshEvent.id);
    await db
      .update(eventOutbox)
      .set({ lockedBy: "dead-worker", lockedAt: new Date("1999-12-31T23:00:00.000Z") })
      .where(eq(eventOutbox.id, staleEvent.id));
    await db
      .update(eventOutbox)
      .set({ lockedBy: "live-worker", lockedAt: new Date("1999-12-31T23:59:45.000Z") })
      .where(eq(eventOutbox.id, freshEvent.id));

    const claimed = await claimOutboxEvents({
      workerId: "replacement-worker",
      batchSize: 10,
      lockTimeoutMs: 30_000,
      now,
    });
    expect(claimed.map((row) => row.id)).toContain(staleEvent.id);
    expect(claimed.map((row) => row.id)).not.toContain(freshEvent.id);

    const staleClaim = claimed.find((row) => row.id === staleEvent.id)!;
    expect(await releaseOutboxEvent(staleClaim, new Error("handler unavailable"), now)).toMatchObject({
      kind: "released",
      attempts: 1,
    });
    const [released] = await db.select().from(eventOutbox).where(eq(eventOutbox.id, staleEvent.id));
    expect(released).toMatchObject({
      attempts: 1,
      lastError: "handler unavailable",
      lockedBy: null,
      lockedAt: null,
    });
    expect(released.availableAt.toISOString()).toBe("2000-01-01T00:00:01.000Z");
  });

  test("fences terminal writes by the claimed lease token", async () => {
    const now = new Date("2100-01-01T00:00:00.000Z");
    const item = event(crypto.randomUUID(), "fenced");
    ids.push(item.id);
    await enqueueDomainEvent(db, item, {
      partitionKey: `fenced-${item.id}`,
      availableAt: new Date("1999-12-31T23:00:00.000Z"),
    });
    const [claimed] = await claimOutboxEvents({
      workerId: "lease-owner",
      batchSize: 1,
      lockTimeoutMs: 30_000,
      now,
    });

    expect(await markOutboxEventPublished(claimed.id, "stale-worker", now)).toEqual({
      kind: "lease_lost",
    });
    expect(await releaseOutboxEvent({ ...claimed, lockedBy: "stale-worker" }, new Error("late"), now)).toEqual({
      kind: "lease_lost",
    });
    expect(await markOutboxEventPublished(claimed.id, claimed.lockedBy, now)).toMatchObject({
      kind: "published",
      publishedAt: now,
    });
  });

  test("dead-letters a poison row and then unblocks its partition", async () => {
    const now = new Date("2001-01-01T00:00:00.000Z");
    const partitionKey = `poison-${crypto.randomUUID()}`;
    const poison = event(crypto.randomUUID(), "poison");
    const following = event(crypto.randomUUID(), "following");
    for (const item of [poison, following]) {
      await enqueueDomainEvent(db, item, {
        partitionKey,
        availableAt: new Date("2000-12-31T23:00:00.000Z"),
      });
      ids.push(item.id);
    }
    await db.update(eventOutbox).set({ createdAt: new Date("2000-12-31T23:00:00.000Z") })
      .where(eq(eventOutbox.id, poison.id));
    await db.update(eventOutbox).set({ createdAt: new Date("2000-12-31T23:00:01.000Z") })
      .where(eq(eventOutbox.id, following.id));

    const claimed = await claimOutboxEvents({
      workerId: "poison-worker", batchSize: 10, lockTimeoutMs: 300_000, now,
    });
    const poisonClaim = claimed.find((row) => row.id === poison.id)!;
    expect(await releaseOutboxEvent(poisonClaim, new Error("unsupported"), now, 1)).toMatchObject({
      kind: "dead",
      attempts: 1,
      deadAt: now,
    });

    const nextClaim = await claimOutboxEvents({
      workerId: "following-worker", batchSize: 10, lockTimeoutMs: 300_000, now,
    });
    expect(nextClaim.map((row) => row.id)).toContain(following.id);
  });

  test("keeps per-partition order and prunes only old successfully published rows", async () => {
    const now = new Date("2002-01-01T00:00:00.000Z");
    const partitionKey = `ordered-${crypto.randomUUID()}`;
    const first = event(crypto.randomUUID(), "first");
    const second = event(crypto.randomUUID(), "second");
    const live = event(crypto.randomUUID(), "live");
    const dead = event(crypto.randomUUID(), "dead");
    for (const item of [first, second, live, dead]) {
      await enqueueDomainEvent(db, item, {
        partitionKey: item === first || item === second ? partitionKey : `other-${item.id}`,
        availableAt: new Date("2001-12-31T23:00:00.000Z"),
      });
      ids.push(item.id);
    }
    await db.update(eventOutbox).set({ createdAt: new Date("2001-12-31T23:00:00.000Z") })
      .where(eq(eventOutbox.id, first.id));
    await db.update(eventOutbox).set({ createdAt: new Date("2001-12-31T23:00:01.000Z") })
      .where(eq(eventOutbox.id, second.id));

    const firstClaim = await claimOutboxEvents({
      workerId: "ordered-worker", batchSize: 10, lockTimeoutMs: 30_000, now,
    });
    expect(firstClaim.map((row) => row.id)).toContain(first.id);
    expect(firstClaim.map((row) => row.id)).not.toContain(second.id);
    const claimedFirst = firstClaim.find((row) => row.id === first.id)!;
    await markOutboxEventPublished(claimedFirst.id, claimedFirst.lockedBy, now);

    const secondClaim = await claimOutboxEvents({
      workerId: "ordered-worker-2", batchSize: 10, lockTimeoutMs: 30_000, now,
    });
    expect(secondClaim.map((row) => row.id)).toContain(second.id);

    await db.update(eventOutbox).set({
      publishedAt: new Date("2000-01-01T00:00:00.000Z"),
      deadAt: null,
    }).where(eq(eventOutbox.id, dead.id));
    await db.update(eventOutbox).set({
      publishedAt: new Date("2000-01-01T00:00:00.000Z"),
      deadAt: new Date("2000-01-02T00:00:00.000Z"),
    }).where(eq(eventOutbox.id, live.id));

    expect(await prunePublishedOutboxEvents({
      before: new Date("2001-01-01T00:00:00.000Z"),
      batchSize: 10,
    })).toBe(1);
    expect(await db.select({ id: eventOutbox.id }).from(eventOutbox)
      .where(eq(eventOutbox.id, dead.id))).toEqual([]);
    expect((await db.select({ id: eventOutbox.id }).from(eventOutbox)
      .where(eq(eventOutbox.id, live.id))).map((row) => row.id)).toEqual([live.id]);
  });
});

function event(id: string, aggregateId: string) {
  return parseDomainEventEnvelope({
    id,
    type: "test.outbox",
    version: 1,
    aggregate: { type: "test", id: aggregateId },
    occurredAt: "1999-12-31T23:00:00.000Z",
    payload: {},
  });
}
