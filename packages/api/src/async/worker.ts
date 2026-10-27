import type { PgBoss } from "pg-boss";
import { createQueueClient, QUEUES, queueConfig } from "./queue";
import { contextFromTraceContext, withSpan } from "../observability";
import { log } from "../logging";
import type { AsyncJobHandler, AsyncMessage, QueueName } from "./types";
export interface AsyncWorkerRuntimeOptions {
  concurrency?: number;
}
export class AsyncWorkerRuntime {
  private boss: PgBoss | undefined;
  private handlers = new Map<string, AsyncJobHandler>();
  constructor(private options: AsyncWorkerRuntimeOptions = {}) {}
  register(handler: AsyncJobHandler) {
    this.handlers.set(handler.name, handler);
    return this;
  }
  async start(_queueNames: QueueName[]) {
    const boss = createQueueClient({ worker: true });
    await boss.start();
    this.boss = boss;
    await boss.work<
      { name: string; message: AsyncMessage },
      never,
      {
        includeMetadata: true;
        perJobResults: true;
        batchSize: number;
        localConcurrency: number;
        pollingIntervalSeconds: number;
      }
    >(
      QUEUES.bots,
      {
        includeMetadata: true,
        perJobResults: true,
        batchSize: 1,
        localConcurrency:
          this.options.concurrency ?? queueConfig.concurrency[QUEUES.bots],
        pollingIntervalSeconds: 0.5,
      },
      async ([job]) => {
        const handler = this.handlers.get(job.data.name);
        try {
          if (!handler) throw Error("Missing bot dispatch handler");
          await withSpan(
            "async.worker.handle",
            { "messaging.system": "pg-boss", "async.job.name": job.data.name },
            () =>
              handler.handle(
                {
                  queue: handler.queue,
                  name: job.data.name,
                  jobId: job.id,
                  message: job.data.message,
                  attemptsMade: job.retryCount,
                  maxAttempts: job.retryLimit + 1,
                },
                {
                  signal: job.signal,
                },
              ),
            {
              parentContext: contextFromTraceContext(
                job.data.message.traceContext,
              ),
              recordException: false,
            },
          );
          return [{ id: job.id, status: "completed" }];
        } catch (error) {
          const errorType = error instanceof Error ? error.name : "Error";
          log.warn(
            {
              component: "pg-boss",
              queue: QUEUES.bots,
              jobId: job.id,
              errorType,
            },
            "Bot dispatch failed",
          );
          return [{ id: job.id, status: "failed", output: { errorType } }];
        }
      },
    );
  }
  async close(force = false) {
    const boss = this.boss;
    this.boss = undefined;
    await boss?.stop({
      graceful: !force,
      timeout: queueConfig.shutdownTimeoutMs,
    });
  }
}
