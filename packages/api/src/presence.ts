import { and, eq, inArray, ne } from "drizzle-orm";
import Redis from "ioredis";
import { db } from "./db";
import { workspaceMembers, users } from "./db/schema";
import { log } from "./logging";

const presenceLog = log.child({ component: "presence" });
const DEFAULT_LEASE_MS = 90_000;

const MARK_ONLINE_SCRIPT = `
redis.call("ZREMRANGEBYSCORE", KEYS[1], "-inf", ARGV[1])
local was_online = redis.call("ZCARD", KEYS[1]) > 0
redis.call("ZADD", KEYS[1], ARGV[2], ARGV[3])
redis.call("PEXPIRE", KEYS[1], ARGV[4])
if was_online then return 0 end
return 1
`;

const MARK_OFFLINE_SCRIPT = `
local was_present = redis.call("ZSCORE", KEYS[1], ARGV[2]) ~= false
redis.call("ZREM", KEYS[1], ARGV[2])
redis.call("ZREMRANGEBYSCORE", KEYS[1], "-inf", ARGV[1])
local remaining = redis.call("ZCARD", KEYS[1])
if remaining == 0 then
  redis.call("DEL", KEYS[1])
  if was_present then
    return 1
  end
end
return 0
`;

export interface PresenceRegistry {
  /** Returns true only for the global offline -> online transition. */
  markOnline(userId: string, connectionId: string): Promise<boolean>;
  /** Returns true only for the global online -> offline transition. */
  markOffline(userId: string, connectionId: string): Promise<boolean>;
  onlineUserIds(candidateUserIds: string[]): Promise<string[]>;
  close?(): Promise<void>;
}

export class LocalPresenceRegistry implements PresenceRegistry {
  private readonly connections = new Map<string, Set<string>>();

  async markOnline(userId: string, connectionId: string): Promise<boolean> {
    let connections = this.connections.get(userId);
    const wasOnline = Boolean(connections?.size);
    if (!connections) {
      connections = new Set();
      this.connections.set(userId, connections);
    }
    connections.add(connectionId);
    return !wasOnline;
  }

  async markOffline(userId: string, connectionId: string): Promise<boolean> {
    const connections = this.connections.get(userId);
    if (!connections) return false;
    connections.delete(connectionId);
    if (connections.size > 0) return false;
    this.connections.delete(userId);
    return true;
  }

  async onlineUserIds(candidateUserIds: string[]): Promise<string[]> {
    return [...new Set(candidateUserIds)].filter(
      (userId) => (this.connections.get(userId)?.size ?? 0) > 0,
    );
  }
}

export interface RedisPresenceRegistryOptions {
  redisUrl?: string;
  redisKeyPrefix?: string;
  leaseMs?: number;
  now?: () => number;
}

/**
 * Replica-safe presence backed by one expiring sorted set per user. Each socket
 * owns one member, so closing one of several desktop windows cannot mark the
 * user offline. Scores are lease expirations; periodic websocket pings renew
 * them and snapshots prune connections left behind by crashed API processes.
 */
export class RedisPresenceRegistry implements PresenceRegistry {
  private readonly redis: Redis;
  private readonly keyPrefix: string;
  private readonly leaseMs: number;
  private readonly now: () => number;

  constructor(options: RedisPresenceRegistryOptions = {}) {
    const redisUrl =
      options.redisUrl ?? process.env.REDIS_URL ?? "redis://localhost:16380";
    const redisKeyPrefix =
      options.redisKeyPrefix ?? process.env.REDIS_KEY_PREFIX ?? "thechat";
    this.keyPrefix = `${redisKeyPrefix}:presence:user`;
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.now = options.now ?? Date.now;
    this.redis = new Redis(redisUrl, {
      connectTimeout: 2_000,
      maxRetriesPerRequest: 2,
    });
    this.redis.on("error", (error) => {
      presenceLog.warn({ err: error }, "Redis presence registry error");
    });
  }

  async markOnline(userId: string, connectionId: string): Promise<boolean> {
    const now = this.now();
    const result = await this.redis.eval(
      MARK_ONLINE_SCRIPT,
      1,
      this.userKey(userId),
      String(now),
      String(now + this.leaseMs),
      connectionId,
      String(this.leaseMs * 2),
    );
    return Number(result) === 1;
  }

  async markOffline(userId: string, connectionId: string): Promise<boolean> {
    const result = await this.redis.eval(
      MARK_OFFLINE_SCRIPT,
      1,
      this.userKey(userId),
      String(this.now()),
      connectionId,
    );
    return Number(result) === 1;
  }

  async onlineUserIds(candidateUserIds: string[]): Promise<string[]> {
    const userIds = [...new Set(candidateUserIds)];
    if (userIds.length === 0) return [];

    const now = this.now();
    const pipeline = this.redis.pipeline();
    for (const userId of userIds) {
      const key = this.userKey(userId);
      pipeline.zremrangebyscore(key, "-inf", now);
      pipeline.zcount(key, now, "+inf");
    }

    const results = await pipeline.exec();
    if (!results) throw new Error("Redis presence pipeline returned no results");

    const online: string[] = [];
    for (let index = 0; index < userIds.length; index += 1) {
      const pruneResult = results[index * 2];
      const countResult = results[index * 2 + 1];
      if (pruneResult?.[0]) throw pruneResult[0];
      if (countResult?.[0]) throw countResult[0];
      if (Number(countResult?.[1] ?? 0) > 0) online.push(userIds[index]);
    }
    return online;
  }

  async close(): Promise<void> {
    if (this.redis.status === "ready") {
      try {
        await this.redis.quit();
      } finally {
        this.redis.disconnect();
      }
      return;
    }
    this.redis.disconnect();
  }

  private userKey(userId: string): string {
    return `${this.keyPrefix}:${userId}`;
  }
}

export async function listSharedWorkspacePeerIds(userId: string): Promise<string[]> {
  const memberships = await db
    .select({ workspaceId: workspaceMembers.workspaceId })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.userId, userId));
  const workspaceIds = [...new Set(memberships.map((item) => item.workspaceId))];
  if (workspaceIds.length === 0) return [];

  const peers = await db
    .selectDistinct({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(
      and(
        inArray(workspaceMembers.workspaceId, workspaceIds),
        ne(workspaceMembers.userId, userId),
        eq(users.type, "human"),
      ),
    );
  return peers.map((peer) => peer.userId);
}

let presenceRegistry: PresenceRegistry | null = null;

export function createPresenceRegistryFromEnv(): PresenceRegistry {
  const driver = (process.env.REALTIME_DRIVER ?? "auto").trim().toLowerCase();
  if (driver === "redis" || (driver === "auto" && process.env.REDIS_URL)) {
    return new RedisPresenceRegistry();
  }
  return new LocalPresenceRegistry();
}

export function getPresenceRegistry(): PresenceRegistry {
  presenceRegistry ??= createPresenceRegistryFromEnv();
  return presenceRegistry;
}

export async function setPresenceRegistryForTests(
  registry: PresenceRegistry,
): Promise<void> {
  await presenceRegistry?.close?.();
  presenceRegistry = registry;
}

export async function closePresenceRegistryForTests(): Promise<void> {
  await presenceRegistry?.close?.();
  presenceRegistry = null;
}
