export interface BotInvocationCleanupConfig {
  enabled: boolean;
  retentionDays: number;
  cleanupIntervalMs: number;
  batchSize: number;
  maxBatchesPerSweep: number;
}

export function loadBotInvocationCleanupConfig(
  env: NodeJS.ProcessEnv = process.env,
): BotInvocationCleanupConfig {
  return {
    enabled: env.BOT_INVOCATION_CLEANUP_ENABLED !== "false",
    retentionDays: boundedInteger(
      env.BOT_INVOCATION_RETENTION_DAYS,
      90,
      30,
      3_650,
    ),
    cleanupIntervalMs: boundedInteger(
      env.BOT_INVOCATION_CLEANUP_INTERVAL_MS,
      60 * 60 * 1_000,
      10_000,
      24 * 60 * 60 * 1_000,
    ),
    batchSize: boundedInteger(
      env.BOT_INVOCATION_CLEANUP_BATCH_SIZE,
      500,
      1,
      5_000,
    ),
    maxBatchesPerSweep: boundedInteger(
      env.BOT_INVOCATION_CLEANUP_MAX_BATCHES,
      10,
      1,
      100,
    ),
  };
}

function boundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed)) return fallback;
  return Math.max(minimum, Math.min(parsed, maximum));
}
