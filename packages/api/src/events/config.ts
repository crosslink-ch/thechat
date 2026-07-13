export interface DomainEventsConfig {
  batchSize: number;
  pollIntervalMs: number;
  lockTimeoutMs: number;
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
  return {
    batchSize: positiveInteger(env.DOMAIN_EVENTS_BATCH_SIZE, 50),
    pollIntervalMs: positiveInteger(env.DOMAIN_EVENTS_POLL_INTERVAL_MS, 500),
    lockTimeoutMs: positiveInteger(
      env.DOMAIN_EVENTS_LOCK_TIMEOUT_MS,
      300_000,
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

function positiveInteger(value: string | undefined, fallback: number) {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
