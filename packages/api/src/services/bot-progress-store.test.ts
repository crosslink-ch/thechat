import { describe, expect, test } from "bun:test";
import crypto from "crypto";
import Redis from "ioredis";
import type { BotProgressStore } from "./bot-progress-store";
import {
  closeBotProgressStoreForTests,
  createLocalBotProgressStoreForTests,
  createResilientBotProgressStoreForTests,
  getBotProgressStore,
} from "./bot-progress-store";

const redisUrl = process.env.REDIS_URL ?? "redis://localhost:16380";

async function deleteRedisPrefix(redis: Redis, prefix: string) {
  let cursor = "0";
  do {
    const [nextCursor, keys] = await redis.scan(
      cursor,
      "MATCH",
      `${prefix}:*`,
      "COUNT",
      500,
    );
    cursor = nextCursor;
    if (keys.length > 0) await redis.del(...keys);
  } while (cursor !== "0");
}

async function waitForRedisCondition(
  condition: () => Promise<boolean>,
  label: string,
  timeoutMs = 2_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await Bun.sleep(20);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function withProductionRedisStore<T>(
  options: {
    ttlSeconds?: number;
    maxEvents?: number;
    activityTimeoutMs?: number;
  },
  run: (context: {
    store: BotProgressStore;
    redis: Redis;
    progressPrefix: string;
  }) => Promise<T>,
) {
  await closeBotProgressStoreForTests();
  const previous = {
    redisKeyPrefix: process.env.REDIS_KEY_PREFIX,
    ttlSeconds: process.env.HERMES_PROGRESS_TTL_SECONDS,
    maxEvents: process.env.HERMES_PROGRESS_MAX_EVENTS,
    activityTimeoutMs: process.env.HERMES_PROGRESS_ACTIVITY_TIMEOUT_MS,
  };
  const redisKeyPrefix = `thechat-progress-test-${crypto.randomUUID()}`;
  const progressPrefix = `${redisKeyPrefix}:bot-progress`;
  process.env.REDIS_KEY_PREFIX = redisKeyPrefix;
  if (options.ttlSeconds !== undefined) {
    process.env.HERMES_PROGRESS_TTL_SECONDS = String(options.ttlSeconds);
  } else {
    delete process.env.HERMES_PROGRESS_TTL_SECONDS;
  }
  if (options.maxEvents !== undefined) {
    process.env.HERMES_PROGRESS_MAX_EVENTS = String(options.maxEvents);
  } else {
    delete process.env.HERMES_PROGRESS_MAX_EVENTS;
  }
  if (options.activityTimeoutMs !== undefined) {
    process.env.HERMES_PROGRESS_ACTIVITY_TIMEOUT_MS = String(options.activityTimeoutMs);
  } else {
    delete process.env.HERMES_PROGRESS_ACTIVITY_TIMEOUT_MS;
  }

  const redis = new Redis(redisUrl, {
    lazyConnect: true,
    connectTimeout: 1_500,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });
  redis.on("error", () => {});
  let connected = false;
  try {
    await redis.connect();
    connected = true;
    return await run({
      store: getBotProgressStore(),
      redis,
      progressPrefix,
    });
  } finally {
    try {
      await closeBotProgressStoreForTests();
      if (connected) await deleteRedisPrefix(redis, redisKeyPrefix);
    } finally {
      try {
        if (connected) {
          await redis.quit();
        } else {
          redis.disconnect();
        }
      } finally {
        restoreEnv("REDIS_KEY_PREFIX", previous.redisKeyPrefix);
        restoreEnv("HERMES_PROGRESS_TTL_SECONDS", previous.ttlSeconds);
        restoreEnv("HERMES_PROGRESS_MAX_EVENTS", previous.maxEvents);
        restoreEnv(
          "HERMES_PROGRESS_ACTIVITY_TIMEOUT_MS",
          previous.activityTimeoutMs,
        );
      }
    }
  }
}

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

describe("production Redis bot progress store", () => {
  test("assigns unique atomic sequences, trims lists, and indexes conversations", async () => {
    await withProductionRedisStore({ maxEvents: 3 }, async ({
      store,
      redis,
      progressPrefix,
    }) => {
      const invocationId = `invocation-${crypto.randomUUID()}`;
      const conversationId = `conversation-${crypto.randomUUID()}`;
      const appended = await Promise.all(
        Array.from({ length: 16 }, (_, index) => store.append(progressInput({
          invocationId,
          conversationId,
          toolCallId: `call-${index + 1}`,
          label: `event-${index + 1}`,
          occurredAt: new Date(Date.now() + index),
        }))),
      );

      expect(new Set(appended.map((event) => event.sequence)).size).toBe(16);
      expect(appended.map((event) => event.sequence).sort((a, b) => a - b)).toEqual(
        Array.from({ length: 16 }, (_, index) => index + 1),
      );
      const listed = await store.listForConversation(conversationId);
      expect(listed.map((event) => event.sequence)).toEqual([14, 15, 16]);
      const labelBySequence = new Map(
        appended.map((event) => [event.sequence, event.label]),
      );
      expect(listed.map((event) => event.label)).toEqual(
        [14, 15, 16].map((sequence) => labelBySequence.get(sequence)!),
      );
      expect(await redis.smembers(
        `${progressPrefix}:conversation:${conversationId}:invocations`,
      )).toEqual([invocationId]);
      expect(await store.listForConversation(`conversation-${crypto.randomUUID()}`)).toEqual([]);
    });
  });

  test("refreshes Redis TTLs on touch and expires the full invocation index", async () => {
    await withProductionRedisStore({ ttlSeconds: 2, activityTimeoutMs: 5_000 }, async ({
      store,
      redis,
      progressPrefix,
    }) => {
      const invocationId = `invocation-${crypto.randomUUID()}`;
      const conversationId = `conversation-${crypto.randomUUID()}`;
      await store.append(progressInput({ invocationId, conversationId }));
      const eventKey = `${progressPrefix}:invocation:${invocationId}:events`;
      const sequenceKey = `${progressPrefix}:invocation:${invocationId}:sequence`;
      const activityKey = `${progressPrefix}:invocation:${invocationId}:activity`;
      const conversationKey = `${progressPrefix}:conversation:${conversationId}:invocations`;
      const keys = [eventKey, sequenceKey, activityKey, conversationKey];
      expect(
        (await Promise.all(keys.map((key) => redis.ttl(key))))
          .every((ttl) => ttl > 0),
      ).toBe(true);

      let agedTtls: number[] = [];
      await waitForRedisCondition(
        async () => {
          const currentTtls = await Promise.all(keys.map((key) => redis.ttl(key)));
          if (!currentTtls.every((ttl) => ttl === 1)) return false;
          agedTtls = currentTtls;
          return true;
        },
        "progress TTLs to reach the pre-touch value",
      );
      await store.touch({ invocationId, conversationId });
      const refreshedTtls = await Promise.all(keys.map((key) => redis.ttl(key)));
      expect(refreshedTtls.every((ttl, index) => ttl > agedTtls[index]!)).toBe(true);

      await waitForRedisCondition(
        async () => (await redis.exists(...keys)) === 0,
        "refreshed progress keys to expire",
        4_000,
      );
      expect(await store.listForConversation(conversationId)).toEqual([]);
    });
  });

  test("backfills candidate indexes, ignores malformed values, and clears stale memberships", async () => {
    await withProductionRedisStore({}, async ({ store, redis, progressPrefix }) => {
      const invocationId = `legacy-${crypto.randomUUID()}`;
      const conversationId = `conversation-${crypto.randomUUID()}`;
      const eventKey = `${progressPrefix}:invocation:${invocationId}:events`;
      const activityKey = `${progressPrefix}:invocation:${invocationId}:activity`;
      const conversationKey = `${progressPrefix}:conversation:${conversationId}:invocations`;
      const validEvent = {
        id: crypto.randomUUID(),
        invocationId,
        botId: "bot-legacy",
        conversationId,
        threadId: null,
        sequence: 7,
        type: "tool.completed",
        status: "completed",
        toolCallId: "legacy-call",
        toolName: "shell",
        label: "legacy evidence",
        preview: null,
        payload: null,
        occurredAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      };
      await redis.rpush(
        eventKey,
        "not-json",
        JSON.stringify({ invocationId, sequence: 6, type: "missing-id" }),
        JSON.stringify(validEvent),
      );

      expect(await store.listForConversation(conversationId, [invocationId])).toEqual([
        validEvent,
      ]);
      expect(await redis.sismember(conversationKey, invocationId)).toBe(1);
      expect(await redis.get(activityKey)).not.toBeNull();

      await store.clear({ invocationId, conversationId });
      expect(await redis.exists(
        eventKey,
        `${progressPrefix}:invocation:${invocationId}:sequence`,
        activityKey,
      )).toBe(0);
      expect(await redis.sismember(conversationKey, invocationId)).toBe(0);

      const staleInvocationId = `stale-${crypto.randomUUID()}`;
      await redis.sadd(conversationKey, staleInvocationId);
      expect(await store.listForConversation(conversationId)).toEqual([]);
      expect(await redis.sismember(conversationKey, staleInvocationId)).toBe(0);
    });
  });

  test("keeps the recovered primary sequence beyond events accepted by the resilient fallback", async () => {
    await withProductionRedisStore({}, async ({ store, redis, progressPrefix }) => {
      const invocationId = `sequence-recovery-${crypto.randomUUID()}`;
      const conversationId = `conversation-${crypto.randomUUID()}`;
      const sequenceKey = `${progressPrefix}:invocation:${invocationId}:sequence`;
      await redis.sadd(sequenceKey, "force-incr-wrongtype");

      const firstFallback = await store.append(progressInput({
        invocationId,
        conversationId,
        type: "tool.started",
        toolCallId: "recovery-call",
        occurredAt: new Date("2026-01-01T00:00:00.000Z"),
      }));
      const secondFallback = await store.append(progressInput({
        invocationId,
        conversationId,
        type: "tool.completed",
        toolCallId: "recovery-call",
        occurredAt: new Date("2026-01-01T00:00:00.001Z"),
      }));
      expect(firstFallback.sequence).toBe(1);
      expect(secondFallback.sequence).toBe(2);
      expect(await redis.type(sequenceKey)).toBe("set");

      await redis.del(sequenceKey);
      const terminal = await store.append(progressInput({
        invocationId,
        conversationId,
        type: "invocation.completed",
        status: "completed",
        toolCallId: null,
        occurredAt: new Date("2026-01-01T00:00:00.002Z"),
      }));
      const merged = await store.listForConversation(conversationId);
      expect(new Set(merged.map((event) => event.id))).toEqual(new Set([
        firstFallback.id,
        secondFallback.id,
        terminal.id,
      ]));
      expect(merged.map((event) => event.sequence)).toEqual([1, 2, 3]);
      expect(terminal.sequence).toBeGreaterThan(secondFallback.sequence);
    });
  });

  test("rejects a clear with a WRONGTYPE conversation index and cleans up after repair", async () => {
    await withProductionRedisStore({}, async ({ store, redis, progressPrefix }) => {
      const invocationId = `clear-recovery-${crypto.randomUUID()}`;
      const conversationId = `conversation-${crypto.randomUUID()}`;
      const eventKey = `${progressPrefix}:invocation:${invocationId}:events`;
      const sequenceKey = `${progressPrefix}:invocation:${invocationId}:sequence`;
      const activityKey = `${progressPrefix}:invocation:${invocationId}:activity`;
      const conversationKey = `${progressPrefix}:conversation:${conversationId}:invocations`;
      await store.append(progressInput({ invocationId, conversationId }));

      await redis.del(conversationKey);
      await redis.set(conversationKey, "force-srem-wrongtype");
      await expect(store.clear({ invocationId, conversationId })).rejects.toThrow(
        "WRONGTYPE",
      );
      expect(await redis.exists(eventKey, sequenceKey, activityKey)).toBe(0);
      expect(await redis.type(conversationKey)).toBe("string");

      await redis.del(conversationKey);
      await store.clear({ invocationId, conversationId });
      expect(await redis.exists(
        eventKey,
        sequenceKey,
        activityKey,
        conversationKey,
      )).toBe(0);
      expect(await store.listForConversation(conversationId)).toEqual([]);
    });
  });
});

describe("local bot progress store", () => {
  test("indexes progress by conversation and expires inactive work", async () => {
    let now = Date.parse("2026-01-01T00:00:00.000Z");
    const store = createLocalBotProgressStoreForTests({
      activityTimeoutMs: 30_000,
      now: () => now,
    });

    await store.append(progressInput({ invocationId: "invocation-1" }));
    await store.append(progressInput({
      invocationId: "invocation-2",
      threadId: "thread-2",
      toolCallId: "call-2",
    }));

    expect((await store.listForConversation("conversation-1")).map((event) => event.invocationId)).toEqual([
      "invocation-1",
      "invocation-2",
    ]);
    expect(await store.listForConversation("conversation-2")).toEqual([]);

    now += 30_001;
    expect(await store.listForConversation("conversation-1")).toEqual([]);

    await store.touch({
      invocationId: "invocation-2",
      conversationId: "conversation-1",
    });
    expect((await store.listForConversation("conversation-1")).map((event) => event.invocationId)).toEqual([
      "invocation-2",
    ]);
  });

  test("retains unresolved approvals without a heartbeat", async () => {
    let now = Date.parse("2026-01-01T00:00:00.000Z");
    const store = createLocalBotProgressStoreForTests({
      activityTimeoutMs: 30_000,
      now: () => now,
    });

    await store.append(progressInput({
      type: "approval.request",
      toolCallId: null,
      payload: { sessionKey: "session-1" },
    }));
    await store.append(progressInput({
      type: "approval.request",
      toolCallId: null,
      payload: { sessionKey: "session-1" },
    }));
    now += 30_001;

    expect(await store.listForConversation("conversation-1")).toHaveLength(2);

    await store.append(progressInput({
      type: "approval.resolved",
      toolCallId: null,
      payload: { sessionKey: "session-1", resolvedCount: 2 },
    }));
    now += 30_001;

    expect(await store.listForConversation("conversation-1")).toEqual([]);
  });

  test("clear removes events and the conversation index", async () => {
    const store = createLocalBotProgressStoreForTests();
    await store.append(progressInput());

    await store.clear({
      invocationId: "invocation-1",
      conversationId: "conversation-1",
    });

    expect(await store.listForConversation("conversation-1")).toEqual([]);
  });
});

describe("resilient bot progress store", () => {
  test("merges fallback events after the primary store recovers", async () => {
    let primaryAvailable = false;
    let now = Date.parse("2026-01-01T00:00:00.000Z");
    const storeOptions = {
      activityTimeoutMs: 30_000,
      now: () => now,
    };
    const primaryLocal = createLocalBotProgressStoreForTests(storeOptions);
    const fallback = createLocalBotProgressStoreForTests(storeOptions);
    const primary: BotProgressStore = {
      append: (input) => primaryAvailable
        ? primaryLocal.append(input)
        : Promise.reject(new Error("primary unavailable")),
      touch: (input) => primaryAvailable
        ? primaryLocal.touch(input)
        : Promise.reject(new Error("primary unavailable")),
      listForConversation: (conversationId, candidates) => primaryAvailable
        ? primaryLocal.listForConversation(conversationId, candidates)
        : Promise.reject(new Error("primary unavailable")),
      clear: (input) => primaryLocal.clear(input),
      close: () => primaryLocal.close?.() ?? Promise.resolve(),
    };
    const store = createResilientBotProgressStoreForTests(primary, fallback);

    await store.append(progressInput({
      type: "approval.request",
      toolCallId: null,
      occurredAt: new Date(now),
    }));
    now += 31_000;
    primaryAvailable = true;
    await store.append(progressInput({
      type: "tool.started",
      occurredAt: new Date(now),
    }));

    const merged = await store.listForConversation("conversation-1");
    expect(merged.map((event) => event.type)).toEqual([
      "approval.request",
      "tool.started",
    ]);
    expect(merged.map((event) => event.sequence)).toEqual([1, 2]);
    await store.close?.();
  });

  test("keeps raw terminal sequence beyond the recovery barrier while retaining delayed fallback evidence", async () => {
    let primaryAvailable = false;
    let now = Date.parse("2026-01-01T00:00:00.000Z");
    const storeOptions = {
      activityTimeoutMs: 30_000,
      now: () => now,
    };
    const primaryLocal = createLocalBotProgressStoreForTests(storeOptions);
    const fallback = createLocalBotProgressStoreForTests(storeOptions);
    const primary: BotProgressStore = {
      append: (input) => primaryAvailable
        ? primaryLocal.append(input)
        : Promise.reject(new Error("primary unavailable")),
      touch: (input) => primaryAvailable
        ? primaryLocal.touch(input)
        : Promise.reject(new Error("primary unavailable")),
      listForConversation: (conversationId, candidates) => primaryAvailable
        ? primaryLocal.listForConversation(conversationId, candidates)
        : Promise.reject(new Error("primary unavailable")),
      clear: (input) => primaryAvailable
        ? primaryLocal.clear(input)
        : Promise.reject(new Error("primary unavailable")),
      close: () => primaryLocal.close?.() ?? Promise.resolve(),
    };
    const store = createResilientBotProgressStoreForTests(primary, fallback);
    try {
      const firstFallback = await store.append(progressInput({
        type: "tool.started",
        toolCallId: "outage-call",
        occurredAt: new Date(now),
      }));
      now += 1;
      const delayedFallback = await store.append(progressInput({
        type: "tool.completed",
        toolCallId: "outage-call",
        occurredAt: new Date(now),
      }));
      expect(firstFallback.sequence).toBe(1);
      expect(delayedFallback.sequence).toBe(2);

      primaryAvailable = true;
      now += 1;
      const terminal = await store.append(progressInput({
        type: "invocation.completed",
        status: "completed",
        toolCallId: null,
        occurredAt: new Date(now),
      }));
      const merged = await store.listForConversation("conversation-1");
      expect(merged.map((event) => event.type)).toEqual([
        "tool.started",
        "tool.completed",
        "invocation.completed",
      ]);
      expect(merged.map((event) => event.id)).toEqual([
        firstFallback.id,
        delayedFallback.id,
        terminal.id,
      ]);
      expect(merged.map((event) => event.sequence)).toEqual([1, 2, 3]);

      // A terminal event accepted after recovery is a global barrier. Its raw
      // sequence must not move behind already accepted fallback evidence.
      expect(terminal.sequence).toBeGreaterThan(delayedFallback.sequence);
    } finally {
      await store.close?.();
    }
  });

  test("surfaces clear failure after local fallback cleanup and allows an idempotent recovery retry", async () => {
    let primaryAvailable = true;
    const primaryLocal = createLocalBotProgressStoreForTests();
    const fallback = createLocalBotProgressStoreForTests();
    const primary: BotProgressStore = {
      append: (input) => primaryAvailable
        ? primaryLocal.append(input)
        : Promise.reject(new Error("primary unavailable")),
      touch: (input) => primaryAvailable
        ? primaryLocal.touch(input)
        : Promise.reject(new Error("primary unavailable")),
      listForConversation: (conversationId, candidates) => primaryAvailable
        ? primaryLocal.listForConversation(conversationId, candidates)
        : Promise.reject(new Error("primary unavailable")),
      clear: (input) => primaryAvailable
        ? primaryLocal.clear(input)
        : Promise.reject(new Error("primary unavailable")),
      close: () => primaryLocal.close?.() ?? Promise.resolve(),
    };
    const store = createResilientBotProgressStoreForTests(primary, fallback);
    try {
      const primaryEvent = await store.append(progressInput());
      primaryAvailable = false;
      await expect(store.clear({
        invocationId: "invocation-1",
        conversationId: "conversation-1",
      })).rejects.toThrow("primary unavailable");
      expect(await store.listForConversation("conversation-1")).toEqual([]);

      primaryAvailable = true;
      expect(await store.listForConversation("conversation-1")).toEqual([primaryEvent]);
      await store.clear({
        invocationId: "invocation-1",
        conversationId: "conversation-1",
      });
      expect(await store.listForConversation("conversation-1")).toEqual([]);
    } finally {
      await store.close?.();
    }
  });

  test("preserves outage-accepted events across independent replica fallbacks", async () => {
    const unavailablePrimary: BotProgressStore = {
      append: () => Promise.reject(new Error("primary unavailable")),
      touch: () => Promise.reject(new Error("primary unavailable")),
      listForConversation: () => Promise.reject(new Error("primary unavailable")),
      clear: () => Promise.reject(new Error("primary unavailable")),
    };
    const replicaA = createResilientBotProgressStoreForTests(
      unavailablePrimary,
      createLocalBotProgressStoreForTests(),
    );
    const replicaB = createResilientBotProgressStoreForTests(
      unavailablePrimary,
      createLocalBotProgressStoreForTests(),
    );
    try {
      const acceptedByReplicaA = await replicaA.append(progressInput({
        type: "approval.request",
        toolCallId: null,
        payload: { sessionKey: "replica-boundary" },
      }));
      const visibleFromReplicaB = await replicaB.listForConversation("conversation-1");

      // A process-local fallback cannot satisfy the durability contract by
      // making accepted progress disappear when the next request hits another replica.
      expect(visibleFromReplicaB.map((event) => event.id)).toContain(
        acceptedByReplicaA.id,
      );
    } finally {
      await Promise.allSettled([replicaA.close?.(), replicaB.close?.()]);
    }
  });
});

function progressInput(
  overrides: Partial<Parameters<BotProgressStore["append"]>[0]> = {},
): Parameters<BotProgressStore["append"]>[0] {
  return {
    invocationId: "invocation-1",
    botId: "bot-1",
    conversationId: "conversation-1",
    threadId: null,
    type: "tool.started",
    status: "running",
    toolCallId: "call-1",
    toolName: "shell",
    label: "Shell",
    preview: null,
    payload: null,
    occurredAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}
