import { and, eq, inArray, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
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

/**
 * Restricts a claim to one worker lane. `include` claims only the listed
 * event types; `exclude` claims everything except them. Partition ordering is
 * still checked against every live row, whatever its lane.
 */
export interface OutboxEventTypeFilter {
  include?: readonly string[];
  exclude?: readonly string[];
}

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
  eventTypes?: OutboxEventTypeFilter;
  lane?: string;
  now?: Date;
}): Promise<ClaimedOutboxEvent[]> {
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const staleBeforeIso = new Date(
    now.getTime() - options.lockTimeoutMs,
  ).toISOString();
  const batchSize = Math.max(1, Math.min(options.batchSize, 500));
  const typeFilter = eventTypeCondition(options.eventTypes);

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
          ${typeFilter}
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
      lane: options.lane,
      startedAt,
    },
  );
}

function eventTypeCondition(filter: OutboxEventTypeFilter | undefined): SQL {
  const include = filter?.include ? [...filter.include] : undefined;
  const exclude = filter?.exclude ? [...filter.exclude] : [];
  if (include) {
    if (include.length === 0) return sql`AND FALSE`;
    return sql`AND pending.event_type IN (${sql.join(
      include.map((type) => sql`${type}`),
      sql`, `,
    )})`;
  }
  if (exclude.length === 0) return sql``;
  return sql`AND pending.event_type NOT IN (${sql.join(
    exclude.map((type) => sql`${type}`),
    sql`, `,
  )})`;
}

export async function traceOutboxClaimOperation(
  operation: () => Promise<ClaimedOutboxEvent[]>,
  options: {
    workerId: string;
    batchSize: number;
    lane?: string;
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
  options: { workerId: string; batchSize: number; lane?: string },
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
  options: { workerId: string; batchSize: number; lane?: string },
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
    ...(options.lane ? { "thechat.outbox.lane": options.lane } : {}),
  };
}

function elapsedMs(startedAt: Date) {
  return Math.max(0, Date.now() - startedAt.getTime());
}

/**
 * Extend the lease of rows this worker is still processing. Returns the IDs
 * whose lease was renewed; any other requested ID was lost to another worker
 * (or already finished) and its handler should stop.
 */
export async function renewOutboxLeases(
  ids: readonly string[],
  workerId: string,
  now = new Date(),
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const renewed = await db
    .update(eventOutbox)
    .set({ lockedAt: now })
    .where(
      and(
        inArray(eventOutbox.id, [...ids]),
        eq(eventOutbox.lockedBy, workerId),
        isNull(eventOutbox.publishedAt),
        isNull(eventOutbox.deadAt),
      ),
    )
    .returning({ id: eventOutbox.id });
  return new Set(renewed.map((row) => row.id));
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

/**
 * Give an unfinished claim back without counting a failed attempt, so another
 * worker can take it immediately instead of waiting for the lease to expire.
 * Used when a worker shuts down while a handler is still running.
 */
export async function handOffOutboxEvent(
  event: Pick<ClaimedOutboxEvent, "id" | "lockedBy">,
): Promise<boolean> {
  const updated = await db
    .update(eventOutbox)
    .set({ lockedBy: null, lockedAt: null })
    .where(
      and(
        eq(eventOutbox.id, event.id),
        eq(eventOutbox.lockedBy, event.lockedBy),
        isNull(eventOutbox.publishedAt),
        isNull(eventOutbox.deadAt),
      ),
    )
    .returning({ id: eventOutbox.id });
  return updated.length > 0;
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

// -- Dead-letter queue -------------------------------------------------------
//
// Events that exhausted their attempts (or failed permanently) stay in the
// outbox with `dead_at` set. They are never pruned, never block their
// partition, and are only processed again after an explicit replay.

export interface DeadOutboxEvent {
  id: string;
  eventType: string;
  eventVersion: number;
  aggregateType: string;
  aggregateId: string;
  partitionKey: string;
  attempts: number;
  lastError: string | null;
  createdAt: Date;
  deadAt: Date;
}

export interface DeadOutboxSelector {
  ids?: readonly string[];
  eventType?: string;
}

export async function countDeadOutboxEvents(): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(eventOutbox)
    .where(isNotNull(eventOutbox.deadAt));
  return row?.count ?? 0;
}

export async function listDeadOutboxEvents(
  options: DeadOutboxSelector & { limit?: number } = {},
): Promise<DeadOutboxEvent[]> {
  const limit = Math.max(1, Math.min(options.limit ?? 50, 1_000));
  const rows = await db
    .select({
      id: eventOutbox.id,
      eventType: eventOutbox.eventType,
      eventVersion: eventOutbox.eventVersion,
      aggregateType: eventOutbox.aggregateType,
      aggregateId: eventOutbox.aggregateId,
      partitionKey: eventOutbox.partitionKey,
      attempts: eventOutbox.attempts,
      lastError: eventOutbox.lastError,
      createdAt: eventOutbox.createdAt,
      deadAt: eventOutbox.deadAt,
    })
    .from(eventOutbox)
    .where(deadSelector(options))
    .orderBy(eventOutbox.deadAt, eventOutbox.id)
    .limit(limit);
  return rows.map((row) => ({ ...row, deadAt: row.deadAt! }));
}

/** Full stored event for one dead row, for operator inspection. */
export async function getDeadOutboxEvent(id: string) {
  const [row] = await db
    .select()
    .from(eventOutbox)
    .where(and(eq(eventOutbox.id, id), isNotNull(eventOutbox.deadAt)))
    .limit(1);
  return row ?? null;
}

/**
 * Move dead events back to the live queue with a fresh attempt budget. A
 * replayed row keeps its original position in its partition, so newer events
 * of the same partition wait behind it again until it succeeds or dies.
 */
export async function replayDeadOutboxEvents(
  selector: DeadOutboxSelector,
  now = new Date(),
): Promise<string[]> {
  if (!selector.ids?.length && !selector.eventType) {
    throw new Error("Replay needs explicit event IDs or an event type");
  }
  const replayed = await db
    .update(eventOutbox)
    .set({
      deadAt: null,
      attempts: 0,
      availableAt: now,
      lockedBy: null,
      lockedAt: null,
    })
    .where(deadSelector(selector))
    .returning({ id: eventOutbox.id });
  return replayed.map((row) => row.id);
}

function deadSelector(selector: DeadOutboxSelector) {
  return and(
    isNotNull(eventOutbox.deadAt),
    selector.ids?.length ? inArray(eventOutbox.id, [...selector.ids]) : undefined,
    selector.eventType ? eq(eventOutbox.eventType, selector.eventType) : undefined,
  );
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
