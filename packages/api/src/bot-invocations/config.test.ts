import { describe, expect, test } from "bun:test";
import { loadBotInvocationCleanupConfig } from "./config";

const HOUR_MS = 60 * 60 * 1_000;

describe("bot invocation cleanup config", () => {
  test("uses safe bounded defaults", () => {
    expect(loadBotInvocationCleanupConfig({} as NodeJS.ProcessEnv)).toEqual({
      enabled: true,
      retentionDays: 90,
      cleanupIntervalMs: HOUR_MS,
      batchSize: 500,
      maxBatchesPerSweep: 10,
    });
  });

  test("accepts explicit operational overrides", () => {
    expect(
      loadBotInvocationCleanupConfig({
        BOT_INVOCATION_CLEANUP_ENABLED: "false",
        BOT_INVOCATION_RETENTION_DAYS: "120",
        BOT_INVOCATION_CLEANUP_INTERVAL_MS: String(2 * HOUR_MS),
        BOT_INVOCATION_CLEANUP_BATCH_SIZE: "250",
        BOT_INVOCATION_CLEANUP_MAX_BATCHES: "4",
      } as NodeJS.ProcessEnv),
    ).toEqual({
      enabled: false,
      retentionDays: 120,
      cleanupIntervalMs: 2 * HOUR_MS,
      batchSize: 250,
      maxBatchesPerSweep: 4,
    });
  });

  test("bounds destructive cleanup settings", () => {
    expect(
      loadBotInvocationCleanupConfig({
        BOT_INVOCATION_RETENTION_DAYS: "99999",
        BOT_INVOCATION_CLEANUP_INTERVAL_MS: "1",
        BOT_INVOCATION_CLEANUP_BATCH_SIZE: "99999",
        BOT_INVOCATION_CLEANUP_MAX_BATCHES: "0",
      } as NodeJS.ProcessEnv),
    ).toMatchObject({
      retentionDays: 3_650,
      cleanupIntervalMs: 10_000,
      batchSize: 5_000,
      maxBatchesPerSweep: 1,
    });
  });

  test("protects the minimum retention window", () => {
    expect(
      loadBotInvocationCleanupConfig({
        BOT_INVOCATION_RETENTION_DAYS: "0",
      } as NodeJS.ProcessEnv).retentionDays,
    ).toBe(30);
  });
});
