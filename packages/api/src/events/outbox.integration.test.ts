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
  releaseOutboxEvent,
} from "./outbox";

const ids: string[] = [];

afterAll(async () => {
  if (ids.length > 0) {
    await db.delete(eventOutbox).where(inArray(eventOutbox.id, ids));
  }
});

describe("transactional outbox claiming", () => {
  test("reclaims stale locks, preserves fresh locks, and records retry state", async () => {
    const now = new Date("2000-01-01T00:00:00.000Z");
    const staleEvent = event(crypto.randomUUID(), "stale");
    const freshEvent = event(crypto.randomUUID(), "fresh");
    await enqueueDomainEvent(db, staleEvent, {
      partitionKey: "conversation-stale",
      availableAt: new Date("1999-12-31T23:00:00.000Z"),
    });
    ids.push(staleEvent.id);
    await enqueueDomainEvent(db, freshEvent, {
      partitionKey: "conversation-fresh",
      availableAt: new Date("1999-12-31T23:00:00.000Z"),
    });
    ids.push(freshEvent.id);
    await db
      .update(eventOutbox)
      .set({
        lockedBy: "dead-worker",
        lockedAt: new Date("1999-12-31T23:00:00.000Z"),
      })
      .where(eq(eventOutbox.id, staleEvent.id));
    await db
      .update(eventOutbox)
      .set({
        lockedBy: "live-worker",
        lockedAt: new Date("1999-12-31T23:59:45.000Z"),
      })
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
    await releaseOutboxEvent(staleClaim, new Error("broker unavailable"), now);
    const [released] = await db
      .select()
      .from(eventOutbox)
      .where(eq(eventOutbox.id, staleEvent.id));
    expect(released).toMatchObject({
      attempts: 1,
      lastError: "broker unavailable",
      lockedBy: null,
      lockedAt: null,
    });
    expect(released.availableAt.toISOString()).toBe(
      "2000-01-01T00:00:01.000Z",
    );
  });

  test("claims only the oldest unpublished event for each partition key", async () => {
    const now = new Date("2000-01-01T00:00:00.000Z");
    const first = event(crypto.randomUUID(), "first");
    const second = event(crypto.randomUUID(), "second");
    for (const item of [first, second]) {
      await enqueueDomainEvent(db, item, {
        partitionKey: "ordered-conversation",
        availableAt: new Date("1999-12-31T23:00:00.000Z"),
      });
      ids.push(item.id);
    }
    await db
      .update(eventOutbox)
      .set({ createdAt: new Date("1999-12-31T23:00:00.000Z") })
      .where(eq(eventOutbox.id, first.id));
    await db
      .update(eventOutbox)
      .set({ createdAt: new Date("1999-12-31T23:00:01.000Z") })
      .where(eq(eventOutbox.id, second.id));

    const firstClaim = await claimOutboxEvents({
      workerId: "ordered-worker-1",
      batchSize: 10,
      lockTimeoutMs: 30_000,
      now,
    });
    expect(firstClaim.map((row) => row.id)).toContain(first.id);
    expect(firstClaim.map((row) => row.id)).not.toContain(second.id);

    const claimedFirst = firstClaim.find((row) => row.id === first.id)!;
    await markOutboxEventPublished(claimedFirst.id, claimedFirst.lockedBy, now);

    const secondClaim = await claimOutboxEvents({
      workerId: "ordered-worker-2",
      batchSize: 10,
      lockTimeoutMs: 30_000,
      now,
    });
    expect(secondClaim.map((row) => row.id)).toContain(second.id);
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
