const MIB = 1024 * 1024;

export interface AttachmentConfig {
  maxBytes: number;
  maxPerMessage: number;
  draftQuotaBytes: number;
  botMaxBytes: number;
  botMaxPerMessage: number;
  botDraftQuotaBytes: number;
  uploadTtlSeconds: number;
  downloadTtlSeconds: number;
  unattachedTtlSeconds: number;
  cleanupIntervalMs: number;
  cleanupBatchSize: number;
}

export function loadAttachmentConfig(
  env: NodeJS.ProcessEnv = process.env,
): AttachmentConfig {
  const maxBytes = boundedInteger(
    env.ATTACHMENT_MAX_BYTES,
    25 * MIB,
    1,
    100 * MIB,
  );
  const maxPerMessage = boundedInteger(
    env.ATTACHMENT_MAX_PER_MESSAGE,
    10,
    1,
    25,
  );

  const draftQuotaBytes = boundedInteger(
    env.ATTACHMENT_DRAFT_QUOTA_BYTES,
    maxBytes * maxPerMessage * 2,
    maxBytes,
    2_000_000_000,
  );

  return {
    maxBytes,
    maxPerMessage,
    draftQuotaBytes,
    botMaxBytes: boundedInteger(
      env.ATTACHMENT_BOT_MAX_BYTES,
      Math.min(maxBytes, 10 * MIB),
      1,
      maxBytes,
    ),
    botMaxPerMessage: boundedInteger(
      env.ATTACHMENT_BOT_MAX_PER_MESSAGE,
      Math.min(maxPerMessage, 5),
      1,
      maxPerMessage,
    ),
    botDraftQuotaBytes: boundedInteger(
      env.ATTACHMENT_BOT_DRAFT_QUOTA_BYTES,
      Math.min(maxBytes * maxPerMessage, 50 * MIB),
      1,
      draftQuotaBytes,
    ),
    uploadTtlSeconds: boundedInteger(
      env.ATTACHMENT_UPLOAD_TTL_SECONDS,
      300,
      60,
      900,
    ),
    downloadTtlSeconds: boundedInteger(
      env.ATTACHMENT_DOWNLOAD_TTL_SECONDS,
      90,
      60,
      120,
    ),
    unattachedTtlSeconds: boundedInteger(
      env.ATTACHMENT_UNATTACHED_TTL_SECONDS,
      30 * 24 * 60 * 60,
      60 * 60,
      365 * 24 * 60 * 60,
    ),
    cleanupIntervalMs: boundedInteger(
      env.ATTACHMENT_CLEANUP_INTERVAL_MS,
      5 * 60 * 1000,
      10_000,
      24 * 60 * 60 * 1000,
    ),
    cleanupBatchSize: boundedInteger(
      env.ATTACHMENT_CLEANUP_BATCH_SIZE,
      100,
      1,
      1_000,
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
