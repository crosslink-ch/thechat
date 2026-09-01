import {
  loadBotInvocationCleanupConfig,
  type BotInvocationCleanupConfig,
} from "./config";
import { pruneTerminalBotInvocations } from "./cleanup";
import { log } from "../logging";

const DAY_MS = 24 * 60 * 60 * 1_000;
const cleanupLog = log.child({ component: "bot-invocation-cleanup" });

type PruneTerminalBotInvocations = typeof pruneTerminalBotInvocations;

export interface BotInvocationCleanupSweepDependencies {
  now?: () => Date;
  prune?: PruneTerminalBotInvocations;
}

export interface BotInvocationCleanupSweepResult {
  deleted: number;
  batches: number;
  limitReached: boolean;
}

export interface BotInvocationCleanupRuntimeDependencies
  extends BotInvocationCleanupSweepDependencies {
  sweep?: () => Promise<BotInvocationCleanupSweepResult>;
  waitForAbort?: (signal: AbortSignal, timeoutMs: number) => Promise<void>;
  onError?: (error: unknown) => void;
}

export interface StartBotInvocationCleanupOptions {
  config?: BotInvocationCleanupConfig;
  dependencies?: BotInvocationCleanupRuntimeDependencies;
}

let sharedRuntime: BotInvocationCleanupRuntime | null = null;

export function startBotInvocationCleanup(
  options: StartBotInvocationCleanupOptions = {},
) {
  if (sharedRuntime) return sharedRuntime;
  const config = options.config ?? loadBotInvocationCleanupConfig();
  sharedRuntime = new BotInvocationCleanupRuntime(
    config,
    options.dependencies,
  );
  sharedRuntime.start();
  if (config.enabled) {
    cleanupLog.info(
      {
        retentionDays: config.retentionDays,
        intervalMs: config.cleanupIntervalMs,
        batchSize: config.batchSize,
        maxBatchesPerSweep: config.maxBatchesPerSweep,
      },
      "Bot invocation cleanup started",
    );
  }
  return sharedRuntime;
}

export async function closeBotInvocationCleanup() {
  if (!sharedRuntime) return;
  const runtime = sharedRuntime;
  try {
    await runtime.close();
  } finally {
    if (sharedRuntime === runtime) sharedRuntime = null;
  }
}

export class BotInvocationCleanupRuntime {
  private abortController: AbortController | null = null;
  private runPromise: Promise<void> | null = null;

  constructor(
    private readonly config: BotInvocationCleanupConfig,
    private readonly dependencies: BotInvocationCleanupRuntimeDependencies = {},
  ) {}

  start() {
    if (this.runPromise) return;
    this.abortController = new AbortController();
    this.runPromise = this.run(this.abortController.signal);
  }

  async close() {
    this.abortController?.abort();
    await this.runPromise;
    this.abortController = null;
    this.runPromise = null;
  }

  private async run(signal: AbortSignal) {
    if (!this.config.enabled) return;
    const wait = this.dependencies.waitForAbort ?? waitForAbort;
    while (!signal.aborted) {
      try {
        let result: BotInvocationCleanupSweepResult;
        if (this.dependencies.sweep) {
          result = await this.dependencies.sweep();
        } else {
          result = await runBotInvocationCleanupSweep(
            this.config,
            this.dependencies,
          );
        }
        if (result.deleted > 0 || result.limitReached) {
          cleanupLog.info(
            {
              deleted: result.deleted,
              batches: result.batches,
              limitReached: result.limitReached,
              retentionDays: this.config.retentionDays,
            },
            "Pruned terminal bot invocations",
          );
        }
      } catch (error) {
        if (this.dependencies.onError) {
          this.dependencies.onError(error);
        } else {
          cleanupLog.error({ err: error }, "Failed to prune bot invocations");
        }
      }
      await wait(signal, this.config.cleanupIntervalMs);
    }
  }
}

export async function runBotInvocationCleanupSweep(
  config: BotInvocationCleanupConfig,
  dependencies: BotInvocationCleanupSweepDependencies = {},
): Promise<BotInvocationCleanupSweepResult> {
  if (!config.enabled) {
    return { deleted: 0, batches: 0, limitReached: false };
  }

  const now = dependencies.now?.() ?? new Date();
  const before = new Date(now.getTime() - config.retentionDays * DAY_MS);
  const prune = dependencies.prune ?? pruneTerminalBotInvocations;
  let deleted = 0;
  let batches = 0;

  while (batches < config.maxBatchesPerSweep) {
    const removed = await prune({ before, batchSize: config.batchSize });
    deleted += removed;
    batches += 1;
    if (removed < config.batchSize) {
      return { deleted, batches, limitReached: false };
    }
  }

  return { deleted, batches, limitReached: true };
}

function waitForAbort(signal: AbortSignal, timeoutMs: number) {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timeout = setTimeout(done, timeoutMs);
    signal.addEventListener("abort", done, { once: true });

    function done() {
      clearTimeout(timeout);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}
