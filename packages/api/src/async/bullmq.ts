import { Queue, type ConnectionOptions, type JobsOptions } from "bullmq";
import { withSpan } from "../observability";
import { toBullMqJobId, toBullMqQueueName } from "./transport";
import type { AsyncBus, AsyncMessage, QueueCommand, QueuedJob } from "./types";

export interface BullMqAsyncBusOptions {
  redisUrl?: string;
  redisKeyPrefix?: string;
}

export function createBullMqConnection(redisUrl = process.env.REDIS_URL ?? "redis://localhost:16380"): ConnectionOptions {
  return {
    url: redisUrl,
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  };
}

export class BullMqAsyncBus implements AsyncBus {
  private readonly queues = new Map<string, Queue<AsyncMessage, unknown, string>>();
  private readonly connection: ConnectionOptions;
  private readonly redisKeyPrefix: string;

  constructor(options: BullMqAsyncBusOptions = {}) {
    this.connection = createBullMqConnection(options.redisUrl);
    this.redisKeyPrefix = options.redisKeyPrefix ?? process.env.REDIS_KEY_PREFIX ?? "thechat";
  }

  async enqueue<TPayload>(command: QueueCommand<TPayload>): Promise<QueuedJob> {
    return withSpan(
      "async.enqueue",
      {
        "async.driver": "bullmq",
        "async.queue": command.queue,
        "async.job.name": command.name,
        "async.job.id": command.jobId,
        "async.message.id": command.message.id,
        "async.aggregate.type": command.message.aggregate.type,
        "async.aggregate.id": command.message.aggregate.id,
      },
      async () => {
        const bullmqJobId = toBullMqJobId(command.jobId);
        const queue = this.getQueue(command.queue);
        const job = await queue.add(command.name, command.message, toBullMqJobOptions(command, bullmqJobId));
        return {
          queue: command.queue,
          name: command.name,
          bullmqJobId: String(job.id ?? bullmqJobId),
          messageId: command.message.id,
        };
      },
    );
  }

  async close(): Promise<void> {
    await Promise.all([...this.queues.values()].map((queue) => queue.close()));
    this.queues.clear();
  }

  private getQueue(queueName: string): Queue<AsyncMessage, unknown, string> {
    const existing = this.queues.get(queueName);
    if (existing) return existing;

    const queue = new Queue<AsyncMessage, unknown, string>(toBullMqQueueName(queueName), {
      connection: this.connection,
      prefix: this.redisKeyPrefix,
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: "exponential", delay: 1_000 },
        removeOnComplete: { age: 7 * 24 * 60 * 60, count: 10_000 },
        removeOnFail: false,
      },
    });
    queue.on("error", (error) => {
      console.error("BullMQ queue error", { queue: queueName, error });
    });
    this.queues.set(queueName, queue);
    return queue;
  }
}

function toBullMqJobOptions(command: QueueCommand, bullmqJobId: string): JobsOptions {
  return {
    jobId: bullmqJobId,
    attempts: command.attempts ?? 5,
    ...(command.backoff ? { backoff: command.backoff } : {}),
    ...(command.delayMs ? { delay: command.delayMs } : {}),
    ...(command.removeOnComplete !== undefined ? { removeOnComplete: command.removeOnComplete } : {}),
    ...(command.removeOnFail !== undefined ? { removeOnFail: command.removeOnFail } : {}),
  };
}
