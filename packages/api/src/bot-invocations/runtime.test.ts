import { describe, expect, test } from "bun:test";
import type { BotInvocationCleanupConfig } from "./config";
import {
  BotInvocationCleanupRuntime,
  closeBotInvocationCleanup,
  runBotInvocationCleanupSweep,
  startBotInvocationCleanup,
} from "./runtime";

const DAY_MS = 24 * 60 * 60 * 1_000;

const config: BotInvocationCleanupConfig = {
  enabled: true,
  retentionDays: 90,
  cleanupIntervalMs: 60 * 60 * 1_000,
  batchSize: 2,
  maxBatchesPerSweep: 10,
};

describe("bot invocation cleanup sweep", () => {
  test("drains full batches until a partial batch is reached", async () => {
    const now = new Date("2026-08-27T12:00:00.000Z");
    const calls: Array<{ before: Date; batchSize: number }> = [];
    const results = [2, 2, 1];

    const result = await runBotInvocationCleanupSweep(config, {
      now: () => now,
      prune: async (options) => {
        calls.push(options);
        return results.shift() ?? 0;
      },
    });

    expect(result).toEqual({ deleted: 5, batches: 3, limitReached: false });
    expect(calls).toHaveLength(3);
    expect(calls.every((call) => call.batchSize === 2)).toBe(true);
    expect(
      calls.every(
        (call) => call.before.getTime() === now.getTime() - 90 * DAY_MS,
      ),
    ).toBe(true);
  });

  test("does no database work when cleanup is disabled", async () => {
    let called = false;

    expect(
      await runBotInvocationCleanupSweep(
        { ...config, enabled: false },
        {
          prune: async () => {
            called = true;
            return 1;
          },
        },
      ),
    ).toEqual({ deleted: 0, batches: 0, limitReached: false });
    expect(called).toBe(false);
  });

  test("stops after the configured maximum number of full batches", async () => {
    let calls = 0;

    expect(
      await runBotInvocationCleanupSweep(
        { ...config, maxBatchesPerSweep: 2 },
        {
          prune: async () => {
            calls += 1;
            return config.batchSize;
          },
        },
      ),
    ).toEqual({ deleted: 4, batches: 2, limitReached: true });
    expect(calls).toBe(2);
  });

  test("runs immediately and aborts the interval wait on close", async () => {
    let resolveFirstSweep!: () => void;
    const firstSweep = new Promise<void>((resolve) => {
      resolveFirstSweep = resolve;
    });
    let resolveWaitStarted!: () => void;
    const waitStarted = new Promise<void>((resolve) => {
      resolveWaitStarted = resolve;
    });
    let sweepCount = 0;
    let waitedFor = 0;
    let observedSignal: AbortSignal | undefined;

    const runtime = new BotInvocationCleanupRuntime(config, {
      sweep: async () => {
        sweepCount += 1;
        resolveFirstSweep();
        return { deleted: 0, batches: 1, limitReached: false };
      },
      waitForAbort: (signal, timeoutMs) => {
        observedSignal = signal;
        waitedFor = timeoutMs;
        resolveWaitStarted();
        return new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    });

    runtime.start();
    await firstSweep;
    await waitStarted;

    expect(sweepCount).toBe(1);
    expect(waitedFor).toBe(config.cleanupIntervalMs);
    expect(observedSignal?.aborted).toBe(false);

    await runtime.close();
    expect(observedSignal?.aborted).toBe(true);
  });

  test("waits and retries after a sweep failure", async () => {
    let attempts = 0;
    const errors: unknown[] = [];
    let resolveSecondSweep!: () => void;
    const secondSweep = new Promise<void>((resolve) => {
      resolveSecondSweep = resolve;
    });

    const runtime = new BotInvocationCleanupRuntime(config, {
      sweep: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("database unavailable");
        resolveSecondSweep();
        return { deleted: 0, batches: 1, limitReached: false };
      },
      onError: (error) => errors.push(error),
      waitForAbort: async (signal) => {
        if (attempts === 1 || signal.aborted) return;
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    });

    runtime.start();
    await secondSweep;

    expect(attempts).toBe(2);
    expect(errors).toHaveLength(1);
    await runtime.close();
  });

  test("starts one shared runtime and releases it on close", async () => {
    const disabledConfig = { ...config, enabled: false };

    const first = startBotInvocationCleanup({ config: disabledConfig });
    const duplicate = startBotInvocationCleanup({ config: disabledConfig });
    expect(duplicate).toBe(first);

    await closeBotInvocationCleanup();

    const restarted = startBotInvocationCleanup({ config: disabledConfig });
    expect(restarted).not.toBe(first);
    await closeBotInvocationCleanup();
  });
});
