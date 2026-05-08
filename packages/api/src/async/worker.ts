import { Worker, type ConnectionOptions, type Job } from "bullmq";
import { withSpan } from "../observability";
import { createBullMqConnection } from "./bullmq";
import { toBullMqQueueName } from "./transport";
import type { AsyncJob, AsyncJobContext, AsyncJobHandler, AsyncMessage, QueueName } from "./types";

export interface AsyncWorkerRuntimeOptions {
  redisUrl?: string;
  redisKeyPrefix?: string;
  concurrency?: number;
}

export class AsyncWorkerRuntime {
  private readonly connection: ConnectionOptions;
  private readonly redisKeyPrefix: string;
  private readonly concurrency: number;
  private readonly handlers = new Map<string, AsyncJobHandler>();
  private readonly workers: Worker<AsyncMessage, unknown, string>[] = [];

  constructor(options: AsyncWorkerRuntimeOptions = {}) {
    this.connection = createBullMqConnection(options.redisUrl);
    this.redisKeyPrefix = options.redisKeyPrefix ?? process.env.REDIS_KEY_PREFIX ?? "thechat";
    this.concurrency = options.concurrency ?? Number(process.env.ASYNC_WORKER_CONCURRENCY ?? 4);
  }

  register(handler: AsyncJobHandler): this {
    this.handlers.set(handlerKey(handler.queue, handler.name), handler);
    return this;
  }

  async start(queueNames: QueueName[]): Promise<void> {
    const uniqueQueueNames = [...new Set(queueNames)];
    for (const queueName of uniqueQueueNames) {
      const worker = new Worker<AsyncMessage, unknown, string>(
        toBullMqQueueName(queueName),
        (job) => this.processBullMqJob(queueName, job),
        {
          connection: this.connection,
          prefix: this.redisKeyPrefix,
          concurrency: this.concurrency,
        },
      );
      worker.on("failed", (job, error) => {
        console.warn("Async worker failed job", {
          queue: queueName,
          jobName: job?.name,
          jobId: job?.id,
          error,
        });
      });
      worker.on("error", (error) => {
        console.error("Async worker queue error", { queue: queueName, error });
      });

      this.workers.push(worker);
      await worker.waitUntilReady();
    }
  }

  async close(force = false): Promise<void> {
    await Promise.all(this.workers.map((worker) => worker.close(force)));
    this.workers.length = 0;
  }

  private async processBullMqJob(queueName: QueueName, bullmqJob: Job<AsyncMessage, unknown, string>): Promise<unknown> {
    const handler = this.handlers.get(handlerKey(queueName, bullmqJob.name));
    if (!handler) {
      throw new Error(`No async handler registered for ${queueName}/${bullmqJob.name}`);
    }

    const asyncJob: AsyncJob = {
      queue: queueName,
      name: bullmqJob.name,
      bullmqJobId: String(bullmqJob.id ?? ""),
      message: bullmqJob.data,
      attemptsMade: bullmqJob.attemptsMade,
      maxAttempts: bullmqJob.opts.attempts ?? 1,
    };

    return withSpan(
      "async.worker.handle",
      {
        "async.queue": queueName,
        "async.job.name": bullmqJob.name,
        "async.job.id": asyncJob.bullmqJobId,
        "async.message.id": bullmqJob.data.id,
        "async.aggregate.type": bullmqJob.data.aggregate.type,
        "async.aggregate.id": bullmqJob.data.aggregate.id,
      },
      async () => {
        const context: AsyncJobContext = {
          setProgress: async (progress, detail) => {
            const normalized = Math.max(0, Math.min(100, Math.round(Number.isFinite(progress) ? progress : 0)));
            await bullmqJob.updateProgress(detail === undefined ? normalized : { progress: normalized, detail });
          },
        };
        return handler.handle(asyncJob, context);
      },
    );
  }
}

function handlerKey(queue: QueueName, name: string): string {
  return `${queue}/${name}`;
}
