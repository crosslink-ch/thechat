import Redis from "ioredis";
import type { WsServerEvent } from "@thechat/shared";
import { withSpan } from "./observability";
import { log } from "./logging";

const realtimeLog = log.child({ component: "realtime" });

export type RealtimeEvent =
  | {
      id: string;
      type: "ws.event";
      targetUserIds: string[];
      event: WsServerEvent;
      occurredAt: string;
    };

export interface RealtimeBus {
  publish(event: RealtimeEvent): Promise<void>;
  subscribe(handler: (event: RealtimeEvent) => void | Promise<void>): Promise<() => Promise<void>>;
  close?(): Promise<void>;
}

type RealtimeDriver = "auto" | "local" | "redis";

export class LocalRealtimeBus implements RealtimeBus {
  private readonly handlers = new Set<(event: RealtimeEvent) => void | Promise<void>>();

  async publish(event: RealtimeEvent): Promise<void> {
    await withSpan(
      "realtime.publish",
      {
        "realtime.driver": "local",
        "realtime.event.type": event.type,
        "realtime.target_users": event.targetUserIds.length,
      },
      async () => {
        await Promise.all([...this.handlers].map((handler) => handler(event)));
      },
    );
  }

  async subscribe(handler: (event: RealtimeEvent) => void | Promise<void>): Promise<() => Promise<void>> {
    this.handlers.add(handler);
    return async () => {
      this.handlers.delete(handler);
    };
  }
}

export interface RedisRealtimeBusOptions {
  redisUrl?: string;
  redisKeyPrefix?: string;
  channel?: string;
}

export class RedisRealtimeBus implements RealtimeBus {
  private readonly publisher: Redis;
  private readonly subscriber: Redis;
  private readonly handlers = new Set<(event: RealtimeEvent) => void | Promise<void>>();
  private readonly channel: string;
  private subscribePromise: Promise<void> | null = null;

  constructor(options: RedisRealtimeBusOptions = {}) {
    const redisUrl = options.redisUrl ?? process.env.REDIS_URL ?? "redis://localhost:16380";
    const keyPrefix = options.redisKeyPrefix ?? process.env.REDIS_KEY_PREFIX ?? "thechat";
    this.channel = options.channel ?? `${keyPrefix}:realtime`;
    this.publisher = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: null });
    this.subscriber = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: null });
    this.subscriber.on("message", (_channel, message) => {
      void this.handleMessage(message);
    });
    this.publisher.on("error", (error) => {
      realtimeLog.warn({ err: error }, "Redis realtime publisher error");
    });
    this.subscriber.on("error", (error) => {
      realtimeLog.warn({ err: error }, "Redis realtime subscriber error");
    });
  }

  async publish(event: RealtimeEvent): Promise<void> {
    await withSpan(
      "realtime.publish",
      {
        "realtime.driver": "redis",
        "realtime.channel": this.channel,
        "realtime.event.type": event.type,
        "realtime.target_users": event.targetUserIds.length,
      },
      async () => {
        await connectRedisIfNeeded(this.publisher);
        await this.publisher.publish(this.channel, JSON.stringify(event));
      },
    );
  }

  async subscribe(handler: (event: RealtimeEvent) => void | Promise<void>): Promise<() => Promise<void>> {
    this.handlers.add(handler);
    await this.ensureSubscribed();
    return async () => {
      this.handlers.delete(handler);
    };
  }

  async close(): Promise<void> {
    this.handlers.clear();
    await Promise.allSettled([this.publisher.quit(), this.subscriber.quit()]);
  }

  private async ensureSubscribed(): Promise<void> {
    if (!this.subscribePromise) {
      this.subscribePromise = (async () => {
        await connectRedisIfNeeded(this.subscriber);
        await this.subscriber.subscribe(this.channel);
      })();
    }
    await this.subscribePromise;
  }

  private async handleMessage(message: string): Promise<void> {
    let event: RealtimeEvent;
    try {
      event = JSON.parse(message);
    } catch (error) {
      realtimeLog.warn({ err: error }, "Invalid realtime message");
      return;
    }
    await withSpan(
      "realtime.receive",
      {
        "realtime.driver": "redis",
        "realtime.channel": this.channel,
        "realtime.event.type": event.type,
        "realtime.target_users": event.targetUserIds.length,
      },
      async () => {
        await Promise.all([...this.handlers].map((handler) => handler(event)));
      },
    );
  }
}

async function connectRedisIfNeeded(redis: Redis): Promise<void> {
  if (redis.status === "ready" || redis.status === "connecting" || redis.status === "connect") return;
  await redis.connect();
}

let realtimeBus: RealtimeBus | null = null;

export function createRealtimeBusFromEnv(): RealtimeBus {
  const driver = (process.env.REALTIME_DRIVER ?? "auto") as RealtimeDriver;
  const redisUrl = process.env.REDIS_URL;
  if (driver === "redis" || (driver === "auto" && redisUrl)) {
    return new RedisRealtimeBus();
  }
  return new LocalRealtimeBus();
}

export function getRealtimeBus(): RealtimeBus {
  realtimeBus ??= createRealtimeBusFromEnv();
  return realtimeBus;
}

export async function setRealtimeBusForTests(bus: RealtimeBus): Promise<void> {
  await realtimeBus?.close?.();
  realtimeBus = bus;
}

export async function closeRealtimeBusForTests(): Promise<void> {
  await realtimeBus?.close?.();
  realtimeBus = null;
}

export async function publishWsEventToUsers(targetUserIds: string[], event: WsServerEvent): Promise<void> {
  const uniqueTargetUserIds = [...new Set(targetUserIds)];
  if (uniqueTargetUserIds.length === 0) return;
  await getRealtimeBus().publish({
    id: crypto.randomUUID(),
    type: "ws.event",
    targetUserIds: uniqueTargetUserIds,
    event,
    occurredAt: new Date().toISOString(),
  });
}
