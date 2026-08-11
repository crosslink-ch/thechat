import { afterAll, describe, expect, test } from "bun:test";
import crypto from "crypto";
import {
  LocalPresenceRegistry,
  RedisPresenceRegistry,
  type PresenceRegistry,
} from "./presence";

const redisRegistries: PresenceRegistry[] = [];

afterAll(async () => {
  await Promise.all(redisRegistries.map((registry) => registry.close?.()));
});

describe("LocalPresenceRegistry", () => {
  test("only transitions on the first connection and last disconnection", async () => {
    const registry = new LocalPresenceRegistry();

    expect(await registry.markOnline("user-1", "socket-1")).toBe(true);
    expect(await registry.markOnline("user-1", "socket-2")).toBe(false);
    expect(await registry.onlineUserIds(["user-1", "user-2", "user-1"])).toEqual([
      "user-1",
    ]);

    expect(await registry.markOffline("user-1", "socket-1")).toBe(false);
    expect(await registry.markOffline("user-1", "socket-2")).toBe(true);
    expect(await registry.markOffline("user-1", "socket-2")).toBe(false);
    expect(await registry.onlineUserIds(["user-1"])).toEqual([]);
  });
});

describe("RedisPresenceRegistry", () => {
  test("shares multi-socket state across API replicas", async () => {
    const prefix = `thechat-test-presence-${crypto.randomUUID()}`;
    const firstReplica = new RedisPresenceRegistry({ redisKeyPrefix: prefix });
    const secondReplica = new RedisPresenceRegistry({ redisKeyPrefix: prefix });
    redisRegistries.push(firstReplica, secondReplica);

    expect(await firstReplica.markOnline("user-1", "socket-1")).toBe(true);
    expect(await secondReplica.onlineUserIds(["user-1", "user-2"])).toEqual([
      "user-1",
    ]);
    expect(await secondReplica.markOnline("user-1", "socket-2")).toBe(false);

    expect(await firstReplica.markOffline("user-1", "socket-1")).toBe(false);
    expect(await secondReplica.onlineUserIds(["user-1"])).toEqual(["user-1"]);
    expect(await secondReplica.markOffline("user-1", "socket-2")).toBe(true);
    expect(await secondReplica.markOffline("user-1", "socket-2")).toBe(false);
    expect(await firstReplica.onlineUserIds(["user-1"])).toEqual([]);
  });

  test("drops expired connections from snapshots", async () => {
    let now = 1_000;
    const registry = new RedisPresenceRegistry({
      redisKeyPrefix: `thechat-test-presence-expiry-${crypto.randomUUID()}`,
      leaseMs: 1_000,
      now: () => now,
    });
    redisRegistries.push(registry);

    await registry.markOnline("user-1", "socket-1");
    expect(await registry.onlineUserIds(["user-1"])).toEqual(["user-1"]);

    now = 2_001;
    expect(await registry.onlineUserIds(["user-1"])).toEqual([]);
  });
});
