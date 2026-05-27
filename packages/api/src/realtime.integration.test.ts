import { afterAll, describe, expect, test } from "bun:test";
import Redis from "ioredis";
import { RedisRealtimeBus, type RealtimeEvent } from "./realtime";

const redisUrl = process.env.REDIS_URL ?? "redis://localhost:16380";
const redisKeyPrefix = `thechat-realtime-test-${crypto.randomUUID()}`;

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

describe("Redis realtime bus integration", () => {
  test("fans out websocket events between independent API-instance buses", async () => {
    const busA = new RedisRealtimeBus({ redisUrl, redisKeyPrefix });
    const busB = new RedisRealtimeBus({ redisUrl, redisKeyPrefix });

    let resolveReceived!: (event: RealtimeEvent) => void;
    const received = new Promise<RealtimeEvent>((resolve) => {
      resolveReceived = resolve;
    });

    const unsubscribe = await busB.subscribe((event) => {
      resolveReceived(event);
    });

    try {
      const event: RealtimeEvent = {
        id: crypto.randomUUID(),
        type: "ws.event",
        targetUserIds: ["user-b"],
        event: {
          type: "typing",
          conversationId: "conversation-1",
          threadId: null,
          userId: "user-a",
          userName: "Alice",
        },
        occurredAt: new Date().toISOString(),
      };

      await busA.publish(event);
      await expect(received).resolves.toMatchObject({
        type: "ws.event",
        targetUserIds: ["user-b"],
        event: { type: "typing", userName: "Alice" },
      });
    } finally {
      await unsubscribe();
      await busA.close();
      await busB.close();
    }
  });
});
