import { afterAll, describe, expect, test } from "bun:test";
import Redis from "ioredis";
import { BullMqAsyncBus } from "./bullmq";
import { AsyncWorkerRuntime } from "./worker";
import type { AsyncJobHandler } from "./types";

const redisUrl = process.env.REDIS_URL ?? "redis://localhost:16380";
const redisKeyPrefix = `thechat-test-${crypto.randomUUID()}`;
const queueName = "thechat:test";

async function deleteRedisPrefix(prefix: string) {
  const redis = new Redis(redisUrl);
  try {
    let cursor = "0";
    do {
      const [nextCursor, keys] = await redis.scan(cursor, "MATCH", `${prefix}:*`, "COUNT", 500);
      cursor = nextCursor;
      if (keys.length > 0) await redis.del(...keys);
    } while (cursor !== "0");
  } finally {
    await redis.quit();
  }
}

afterAll(async () => {
  await deleteRedisPrefix(redisKeyPrefix);
});

describe("BullMQ async bus integration", () => {
  test("enqueues a real Redis-backed job and processes it with a worker", async () => {
    const bus = new BullMqAsyncBus({ redisUrl, redisKeyPrefix });
    const worker = new AsyncWorkerRuntime({ redisUrl, redisKeyPrefix, concurrency: 1 });

    let resolveProcessed!: (value: { value: string; progress: unknown }) => void;
    const processed = new Promise<{ value: string; progress: unknown }>((resolve) => {
      resolveProcessed = resolve;
    });

    const handler: AsyncJobHandler<{ value: string }> = {
      queue: queueName,
      name: "test.echo",
      async handle(job, context) {
        await context.setProgress(42, { phase: "received" });
        resolveProcessed({ value: job.message.payload.value, progress: 42 });
        return { ok: true };
      },
    };

    worker.register(handler);
    await worker.start([queueName]);

    try {
      const queued = await bus.enqueue({
        queue: queueName,
        name: "test.echo",
        jobId: "bot:invoke:trigger-message:bot-id",
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: true,
        message: {
          id: `msg_${crypto.randomUUID()}`,
          type: "test.echo",
          version: 1,
          aggregate: { type: "test", id: "one" },
          correlationId: crypto.randomUUID(),
          occurredAt: new Date().toISOString(),
          payload: { value: "hello from BullMQ" },
        },
      });

      expect(queued.queue).toBe(queueName);
      expect(queued.bullmqJobId).toBe("bot__invoke__trigger-message__bot-id");
      await expect(processed).resolves.toEqual({ value: "hello from BullMQ", progress: 42 });
    } finally {
      await worker.close(true);
      await bus.close();
    }
  });
});
