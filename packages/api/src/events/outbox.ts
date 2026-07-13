import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { eventOutbox } from "../db/schema";
import type { DomainEventEnvelope } from "./envelope";
import { withSpan } from "../observability";
import { retryDelayMs } from "./retry";

export interface ClaimedOutboxEvent {
  [key: string]: unknown;
  id: string;
  event: unknown;
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

export async function enqueueDomainEvent(
  executor: OutboxInsertExecutor,
  event: DomainEventEnvelope,
  options: { partitionKey: string; availableAt?: Date },
) {
  await executor.insert(eventOutbox).values({
    id: event.id,
    eventType: event.type,
    eventVersion: event.version,
    aggregateType: event.aggregate.type,
    aggregateId: event.aggregate.id,
    actorType: event.actor?.type,
    actorId: event.actor?.id,
    tenantId: event.tenant?.workspaceId,
    correlationId: event.correlationId,
    causationId: event.causationId,
    partitionKey: options.partitionKey,
    event,
    availableAt: options.availableAt,
  });
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

  return withSpan(
    "domain_event.outbox.claim",
    {
      "messaging.system": "thechat-domain-events",
      "messaging.operation": "receive",
      "thechat.outbox.worker_id": options.workerId,
      "thechat.outbox.batch_size": batchSize,
    },
    async (span) => {
      const rows = await db.transaction(async (tx) => {
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
            outbox.partition_key AS "partitionKey",
            outbox.attempts,
            outbox.locked_by AS "lockedBy",
            outbox.locked_at AS "lockedAt",
            outbox.created_at AS "createdAt"
        `);
        return Array.from(claimed);
      });
      span.setAttribute("thechat.outbox.claimed_count", rows.length);
      return rows;
    },
  );
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
    .where(
      and(eq(eventOutbox.id, id), eq(eventOutbox.lockedBy, workerId)),
    )
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
