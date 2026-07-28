import { and, eq, sql } from "drizzle-orm";
import { SpanKind } from "@opentelemetry/api";
import { db } from "../db";
import { eventOutbox } from "../db/schema";
import type { DomainEventEnvelope } from "./envelope";
import { activeTraceContext, withSpan } from "../observability";
import { retryDelayMs } from "./retry";

export interface ClaimedOutboxEvent {
  [key: string]: unknown;
  id: string;
  event: unknown;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  partitionKey: string;
  attempts: number;
  lockedBy: string;
  lockedAt: Date;
  createdAt: Date;
}

export type MarkPublishedOutcome =
  | { kind: "published"; publishedAt: Date }
  | { kind: "lease_lost" };

export type ReleaseOutboxOutcome =
  | { kind: "released"; attempts: number; deadAt: null }
  | { kind: "dead"; attempts: number; deadAt: Date }
  | { kind: "lease_lost" };

type OutboxInsertExecutor = Pick<typeof db, "insert">;

export const OUTBOX_SLOW_CLAIM_MS = 100;

export async function enqueueDomainEvent(
  executor: OutboxInsertExecutor,
  event: DomainEventEnvelope,
  options: { partitionKey: string; availableAt?: Date },
) {
  return withSpan(
    "domain_event.outbox.enqueue",
    {
      "messaging.system": "postgresql-outbox",
      "messaging.operation": "publish",
      "messaging.message.type": event.type,
      "thechat.aggregate.type": event.aggregate.type,
      "thechat.outbox.delayed": Boolean(options.availableAt),
    },
    async (span) => {
      const traceContext = activeTraceContext();
      const persistedEvent = traceContext ? { ...event, traceContext } : event;
      await executor.insert(eventOutbox).values({
        id: persistedEvent.id,
        eventType: persistedEvent.type,
        eventVersion: persistedEvent.version,
        aggregateType: persistedEvent.aggregate.type,
        aggregateId: persistedEvent.aggregate.id,
        actorType: persistedEvent.actor?.type,
        actorId: persistedEvent.actor?.id,
        tenantId: persistedEvent.tenant?.workspaceId,
        correlationId: persistedEvent.correlationId,
        causationId: persistedEvent.causationId,
        partitionKey: options.partitionKey,
        event: persistedEvent,
        availableAt: options.availableAt,
      });
      // The insert is still inside the caller's transaction here. Do not
      // claim durability until the enclosing business span observes commit.
      span.setAttribute("thechat.outbox.outcome", "staged");
    },
    { kind: SpanKind.PRODUCER },
  );
}

/**
 * Claim only the oldest live row for each partition key. The lease token is the
 * worker ID; every terminal transition fences on that token so a stale worker
 * cannot acknowledge or reschedule a newer owner's claim.
 */
export async function claimOutboxEvents(options: {
  workerId: string;
  batchSize: number;
  lockTimeoutMs: number;
  now?: Date;
}): Promise<ClaimedOutboxEvent[]> {
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const staleBeforeIso = new Date(
    now.getTime() - options.lockTimeoutMs,
  ).toISOString();
  const batchSize = Math.max(1, Math.min(options.batchSize, 500));

  const startedAt = new Date();
  return traceOutboxClaimOperation(
    () =>
      db.transaction(async (tx) => {
        const claimed = await tx.execute<ClaimedOutboxEvent>(sql`
      WITH candidates AS (
        SELECT pending.id
        FROM event_outbox AS pending
        WHERE pending.published_at IS NULL
          AND pending.dead_at IS NULL
          AND pending.available_at <= ${nowIso}
          AND (pending.locked_at IS NULL OR pending.locked_at < ${staleBeforeIso})
          AND NOT EXISTS (
            SELECT 1
            FROM event_outbox AS earlier
            WHERE earlier.partition_key = pending.partition_key
              AND earlier.published_at IS NULL
              AND earlier.dead_at IS NULL
              AND (
                earlier.created_at < pending.created_at
                OR (
                  earlier.created_at = pending.created_at
                  AND earlier.id < pending.id
                )
              )
          )
        ORDER BY pending.created_at, pending.id
        FOR UPDATE OF pending SKIP LOCKED
        LIMIT ${batchSize}
      )
      UPDATE event_outbox AS outbox
      SET locked_by = ${options.workerId}, locked_at = ${nowIso}
      FROM candidates
      WHERE outbox.id = candidates.id
      RETURNING
        outbox.id,
        outbox.event,
        outbox.event_type AS "eventType",
        outbox.aggregate_type AS "aggregateType",
        outbox.aggregate_id AS "aggregateId",
        outbox.partition_key AS "partitionKey",
        outbox.attempts,
        outbox.locked_by AS "lockedBy",
        outbox.locked_at AS "lockedAt",
        outbox.created_at AS "createdAt"
    `);
        return Array.from(claimed);
      }),
    {
      workerId: options.workerId,
      batchSize,
      startedAt,
    },
  );
}

export async function traceOutboxClaimOperation(
  operation: () => Promise<ClaimedOutboxEvent[]>,
  options: {
    workerId: string;
    batchSize: number;
    startedAt?: Date;
    slowThresholdMs?: number;
  },
): Promise<ClaimedOutboxEvent[]> {
  const startedAt = options.startedAt ?? new Date();
  const slowThresholdMs = options.slowThresholdMs ?? OUTBOX_SLOW_CLAIM_MS;
  try {
    const rows = await operation();
    const durationMs = elapsedMs(startedAt);
    if (rows.length === 0 && durationMs < slowThresholdMs) return rows;

    return traceOutboxClaimResult(rows, options, startedAt, durationMs);
  } catch (error) {
    const durationMs = elapsedMs(startedAt);
    return withSpan(
      "domain_event.outbox.claim",
      claimSpanAttributes(options, 0, durationMs, "error"),
      async () => {
        throw error;
      },
      { kind: SpanKind.CLIENT, startTime: startedAt },
    );
  }
}

function traceOutboxClaimResult(
  rows: ClaimedOutboxEvent[],
  options: { workerId: string; batchSize: number },
  startedAt: Date,
  durationMs: number,
): Promise<ClaimedOutboxEvent[]> {
  return withSpan(
    "domain_event.outbox.claim",
    claimSpanAttributes(
      options,
      rows.length,
      durationMs,
      rows.length > 0 ? "claimed" : "slow_empty",
    ),
    () => rows,
    { kind: SpanKind.CLIENT, startTime: startedAt },
  );
}

function claimSpanAttributes(
  options: { workerId: string; batchSize: number },
  claimedCount: number,
  durationMs: number,
  outcome: "claimed" | "slow_empty" | "error",
) {
  return {
    "messaging.system": "postgresql-outbox",
    "messaging.operation": "receive",
    "thechat.outbox.batch_size": options.batchSize,
    "thechat.outbox.claimed_count": claimedCount,
    "thechat.outbox.claim_duration_ms": durationMs,
    "thechat.outbox.outcome": outcome,
  };
}

function elapsedMs(startedAt: Date) {
  return Math.max(0, Date.now() - startedAt.getTime());
}

export async function markOutboxEventPublished(
  id: string,
  workerId: string,
  publishedAt = new Date(),
): Promise<MarkPublishedOutcome> {
  const [updated] = await db
    .update(eventOutbox)
    .set({
      publishedAt,
      lockedBy: null,
      lockedAt: null,
      lastError: null,
    })
    .where(and(eq(eventOutbox.id, id), eq(eventOutbox.lockedBy, workerId)))
    .returning({ publishedAt: eventOutbox.publishedAt });

  return updated?.publishedAt
    ? { kind: "published", publishedAt: updated.publishedAt }
    : { kind: "lease_lost" };
}

export async function releaseOutboxEvent(
  event: Pick<ClaimedOutboxEvent, "id" | "attempts" | "lockedBy">,
  error: unknown,
  now = new Date(),
  maxAttempts = 25,
): Promise<ReleaseOutboxOutcome> {
  const attempts = event.attempts + 1;
  const deadAt = attempts >= maxAttempts ? now : null;
  const [updated] = await db
    .update(eventOutbox)
    .set({
      attempts: sql`${eventOutbox.attempts} + 1`,
      lastError: errorMessage(error).slice(0, 4_000),
      availableAt: new Date(now.getTime() + retryDelayMs(attempts)),
      deadAt,
      lockedBy: null,
      lockedAt: null,
    })
    .where(
      and(
        eq(eventOutbox.id, event.id),
        eq(eventOutbox.lockedBy, event.lockedBy),
      ),
    )
    .returning({
      attempts: eventOutbox.attempts,
      deadAt: eventOutbox.deadAt,
    });

  if (!updated) return { kind: "lease_lost" };
  return updated.deadAt
    ? { kind: "dead", attempts: updated.attempts, deadAt: updated.deadAt }
    : { kind: "released", attempts: updated.attempts, deadAt: null };
}

/** Delete one bounded batch of successful, non-quarantined event rows. */
export async function prunePublishedOutboxEvents(options: {
  before: Date;
  batchSize: number;
}): Promise<number> {
  const batchSize = Math.max(1, Math.min(options.batchSize, 5_000));
  const rows = await db.execute<{ id: string }>(sql`
    WITH candidates AS (
      SELECT id
      FROM event_outbox
      WHERE published_at IS NOT NULL
        AND dead_at IS NULL
        AND published_at < ${options.before.toISOString()}
      ORDER BY published_at, id
      LIMIT ${batchSize}
    )
    DELETE FROM event_outbox AS outbox
    USING candidates
    WHERE outbox.id = candidates.id
    RETURNING outbox.id
  `);
  return Array.from(rows).length;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
