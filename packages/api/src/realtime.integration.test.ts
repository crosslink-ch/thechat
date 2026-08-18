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

  test("recovers after an initial Redis connection failure without retaining failed handlers", async () => {
    const admin = new Redis(redisUrl);
    const username = `thechat-realtime-${crypto.randomUUID()}`;
    const password = crypto.randomUUID();
    const channel = `${redisKeyPrefix}:recovery`;
    const authenticatedUrl = new URL(redisUrl);
    authenticatedUrl.username = username;
    authenticatedUrl.password = password;
    const bus = new RedisRealtimeBus({
      redisUrl: authenticatedUrl.toString(),
      channel,
    });

    let unsubscribe: (() => Promise<void>) | null = null;
    let failedHandlerCalls = 0;
    let activeHandlerCalls = 0;

    try {
      let firstSubscriptionError: unknown;
      try {
        await bus.subscribe(() => {
          failedHandlerCalls += 1;
        });
      } catch (error) {
        firstSubscriptionError = error;
      }
      expect(firstSubscriptionError).toBeDefined();

      await admin.call(
        "ACL",
        "SETUSER",
        username,
        "reset",
        "on",
        `>${password}`,
        "~*",
        "&*",
        "+@all",
      );

      let resolveReceived!: (event: RealtimeEvent) => void;
      const received = new Promise<RealtimeEvent>((resolve) => {
        resolveReceived = resolve;
      });
      unsubscribe = await bus.subscribe((event) => {
        activeHandlerCalls += 1;
        resolveReceived(event);
      });

      const event: RealtimeEvent = {
        id: crypto.randomUUID(),
        type: "ws.event",
        targetUserIds: ["recovered-user"],
        event: {
          type: "typing",
          conversationId: "recovered-conversation",
          threadId: null,
          userId: "recovered-bot",
          userName: "Recovered bot",
        },
        occurredAt: new Date().toISOString(),
      };
      await admin.publish(channel, JSON.stringify(event));

      await expect(received).resolves.toMatchObject({
        id: event.id,
        targetUserIds: ["recovered-user"],
      });
      expect(failedHandlerCalls).toBe(0);
      expect(activeHandlerCalls).toBe(1);
    } finally {
      await unsubscribe?.();
      await bus.close();
      await admin.call("ACL", "DELUSER", username);
      await admin.quit();
    }
  });

  test("single-flights publisher recovery waits and aborts them on close", async () => {
    const username = `thechat-realtime-${crypto.randomUUID()}`;
    const password = crypto.randomUUID();
    const authenticatedUrl = new URL(redisUrl);
    authenticatedUrl.username = username;
    authenticatedUrl.password = password;
    const bus = new RedisRealtimeBus({
      redisUrl: authenticatedUrl.toString(),
      channel: `${redisKeyPrefix}:publisher-recovery`,
    });
    const publisher = (bus as unknown as { publisher: Redis }).publisher;
    publisher.options.retryStrategy = () => 10_000;
    const event: RealtimeEvent = {
      id: crypto.randomUUID(),
      type: "ws.event",
      targetUserIds: ["publisher-recovery-user"],
      event: {
        type: "typing",
        conversationId: "publisher-recovery-conversation",
        threadId: null,
        userId: "publisher-recovery-bot",
        userName: "Publisher recovery bot",
      },
      occurredAt: new Date().toISOString(),
    };

    try {
      let firstPublishError: unknown;
      try {
        await bus.publish(event);
      } catch (error) {
        firstPublishError = error;
      }
      expect(firstPublishError).toBeDefined();
      expect(publisher.status).toBe("reconnecting");

      const pendingPublishes = Array.from({ length: 20 }, () =>
        bus.publish(event).then(
          () => "resolved" as const,
          () => "rejected" as const,
        ),
      );
      const listenerDeadline = Date.now() + 1_000;
      while (
        publisher.listenerCount("ready") === 0 &&
        Date.now() < listenerDeadline
      ) {
        await Bun.sleep(10);
      }

      expect(publisher.listenerCount("ready")).toBe(1);
      expect(publisher.listenerCount("end")).toBe(1);

      await bus.close();
      const outcomes = await Promise.race([
        Promise.all(pendingPublishes),
        Bun.sleep(1_000).then(() => null),
      ]);
      expect(outcomes).toEqual(Array.from({ length: 20 }, () => "rejected"));
      expect(publisher.listenerCount("ready")).toBe(0);
      expect(publisher.listenerCount("end")).toBe(0);
    } finally {
      await bus.close();
    }
  });
});
