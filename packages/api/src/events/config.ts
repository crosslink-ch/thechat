/** Per-runtime overrides for integration tests. Production queue policy and
 * capacity live in async/queue.ts, not dozens of environment feature flags. */
export interface DomainEventsConfig {
  batchSize: number;
  attachmentConcurrency: number;
  shutdownGraceMs: number;
}
