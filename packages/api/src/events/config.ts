export interface DomainEventsConfig {
  /**
   * Maximum events the default lane (chat delivery, bot triggers, bot request
   * answers: everything that is not attachment storage work) runs at once per
   * worker. Freed slots are refilled immediately.
   */
  batchSize: number;
  /**
   * Maximum attachment validation/deletion events one worker runs at once.
   * Validation buffers the whole object in memory, so this stays small.
   */
  attachmentConcurrency: number;
  pollIntervalMs: number;
  /**
   * A claimed row whose lease was not renewed for this long is treated as
   * abandoned (crashed worker) and may be claimed again. Running handlers renew
   * their lease every `lockTimeoutMs / 4`, so this never limits how long a live
   * handler may run; it only bounds how long a dead worker's events stay stuck.
   */
  lockTimeoutMs: number;
  /**
   * Time budget for the first attempt of a default-lane handler. Every retry
   * doubles the budget up to `maxHandlerTimeoutMs`, so work that legitimately
   * needs longer gets it after a retry instead of timing out forever.
   */
  handlerTimeoutMs: number;
  /** First-attempt budget for attachment handlers (large S3 transfers). */
  attachmentHandlerTimeoutMs: number;
  maxHandlerTimeoutMs: number;
  /**
   * After a handler's signal is aborted, how long to wait for it to settle
   * before the worker records the failure and frees the slot anyway.
   */
  handlerAbortGraceMs: number;
  /** How long shutdown waits for running handlers before handing them off. */
  shutdownGraceMs: number;
  maxAttempts: number;
  retentionDays: number;
  pruneIntervalMs: number;
  pruneBatchSize: number;
}

/**
 * Configuration for TheChat's PostgreSQL-backed domain-event outbox.
 *
 * The API never depends on a broker: it stores events in the same transaction
 * as the source write, and the worker drains them directly from PostgreSQL.
 */
export function loadDomainEventsConfig(
  env: NodeJS.ProcessEnv = process.env,
): DomainEventsConfig {
  const handlerTimeoutMs = positiveInteger(
    env.DOMAIN_EVENTS_HANDLER_TIMEOUT_MS,
    60_000,
  );
  const attachmentHandlerTimeoutMs = positiveInteger(
    env.DOMAIN_EVENTS_ATTACHMENT_HANDLER_TIMEOUT_MS,
    300_000,
  );
  return {
    batchSize: positiveInteger(env.DOMAIN_EVENTS_BATCH_SIZE, 50),
    attachmentConcurrency: Math.min(
      positiveInteger(env.ATTACHMENT_VALIDATION_CONCURRENCY, 1),
      8,
    ),
    pollIntervalMs: positiveInteger(env.DOMAIN_EVENTS_POLL_INTERVAL_MS, 500),
    lockTimeoutMs: positiveInteger(env.DOMAIN_EVENTS_LOCK_TIMEOUT_MS, 60_000),
    handlerTimeoutMs,
    attachmentHandlerTimeoutMs,
    maxHandlerTimeoutMs: Math.max(
      handlerTimeoutMs,
      attachmentHandlerTimeoutMs,
      positiveInteger(env.DOMAIN_EVENTS_MAX_HANDLER_TIMEOUT_MS, 1_800_000),
    ),
    handlerAbortGraceMs: positiveInteger(
      env.DOMAIN_EVENTS_HANDLER_ABORT_GRACE_MS,
      5_000,
    ),
    shutdownGraceMs: positiveInteger(
      env.DOMAIN_EVENTS_SHUTDOWN_GRACE_MS,
      20_000,
    ),
    maxAttempts: positiveInteger(env.DOMAIN_EVENTS_MAX_ATTEMPTS, 25),
    retentionDays: positiveInteger(env.DOMAIN_EVENTS_RETENTION_DAYS, 30),
    pruneIntervalMs: positiveInteger(
      env.DOMAIN_EVENTS_PRUNE_INTERVAL_MS,
      3_600_000,
    ),
    pruneBatchSize: positiveInteger(env.DOMAIN_EVENTS_PRUNE_BATCH_SIZE, 500),
  };
}

/**
 * Budget for one attempt: the base budget doubled once per previous failed
 * attempt, capped at `maxMs` (never below the base budget).
 */
export function handlerBudgetMs(
  baseMs: number,
  maxMs: number,
  previousAttempts: number,
) {
  const doublings = Math.max(0, Math.min(previousAttempts, 20));
  return Math.min(Math.max(baseMs, maxMs), baseMs * 2 ** doublings);
}

function positiveInteger(value: string | undefined, fallback: number) {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
