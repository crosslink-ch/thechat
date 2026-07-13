import crypto from "crypto";
import Redis from "ioredis";
import type { BotInvocationProgressEventPublic } from "@thechat/shared";
import { log } from "../logging";

const botProgressLog = log.child({ component: "bot-progress-store" });

const DEFAULT_PROGRESS_TTL_SECONDS = 60 * 60;
const DEFAULT_PROGRESS_MAX_EVENTS = 100;

interface ProgressEventInput {
  invocationId: string;
  botId: string;
  conversationId: string;
  threadId: string | null;
  type: string;
  status: string | null;
  toolCallId: string | null;
  toolName: string | null;
  label: string | null;
  preview: string | null;
  payload: Record<string, unknown> | null;
  occurredAt: Date;
}

export interface BotProgressStore {
  append(input: ProgressEventInput): Promise<BotInvocationProgressEventPublic>;
  listForInvocations(invocationIds: string[]): Promise<BotInvocationProgressEventPublic[]>;
  close?(): Promise<void>;
}

class RedisBotProgressStore implements BotProgressStore {
  private readonly redis: Redis;
  private readonly keyPrefix: string;
  private readonly ttlSeconds: number;
  private readonly maxEvents: number;

  constructor(options: {
    redisUrl?: string;
    redisKeyPrefix?: string;
    ttlSeconds?: number;
    maxEvents?: number;
  } = {}) {
    const redisUrl = options.redisUrl ?? process.env.REDIS_URL ?? "redis://localhost:16380";
    this.keyPrefix = `${options.redisKeyPrefix ?? process.env.REDIS_KEY_PREFIX ?? "thechat"}:bot-progress`;
    this.ttlSeconds = options.ttlSeconds ?? readPositiveInt(
      process.env.HERMES_PROGRESS_TTL_SECONDS,
      DEFAULT_PROGRESS_TTL_SECONDS,
    );
    this.maxEvents = options.maxEvents ?? readPositiveInt(
      process.env.HERMES_PROGRESS_MAX_EVENTS,
      DEFAULT_PROGRESS_MAX_EVENTS,
    );
    this.redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: null });
    this.redis.on("error", (error) => {
      botProgressLog.warn({ err: error }, "Redis bot progress store error");
    });
  }

  async append(input: ProgressEventInput): Promise<BotInvocationProgressEventPublic> {
    await connectRedisIfNeeded(this.redis);
    const sequenceKey = this.sequenceKey(input.invocationId);
    const eventKey = this.eventKey(input.invocationId);
    const sequence = await this.redis.incr(sequenceKey);
    const now = new Date();
    const event: BotInvocationProgressEventPublic = {
      id: crypto.randomUUID(),
      invocationId: input.invocationId,
      botId: input.botId,
      conversationId: input.conversationId,
      threadId: input.threadId,
      sequence,
      type: input.type,
      status: input.status,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      label: input.label,
      preview: input.preview,
      payload: input.payload,
      occurredAt: input.occurredAt.toISOString(),
      createdAt: now.toISOString(),
    };

    const pipeline = this.redis.pipeline();
    pipeline.rpush(eventKey, JSON.stringify(event));
    pipeline.ltrim(eventKey, -this.maxEvents, -1);
    pipeline.expire(eventKey, this.ttlSeconds);
    pipeline.expire(sequenceKey, this.ttlSeconds);
    await pipeline.exec();
    return event;
  }

  async listForInvocations(invocationIds: string[]): Promise<BotInvocationProgressEventPublic[]> {
    if (invocationIds.length === 0) return [];
    await connectRedisIfNeeded(this.redis);
    const pipeline = this.redis.pipeline();
    for (const invocationId of invocationIds) {
      pipeline.lrange(this.eventKey(invocationId), 0, -1);
    }
    const results = await pipeline.exec();
    const events: BotInvocationProgressEventPublic[] = [];
    for (const result of results ?? []) {
      const [error, value] = result;
      if (error || !Array.isArray(value)) continue;
      for (const raw of value) {
        const parsed = parseProgressEvent(raw);
        if (parsed) events.push(parsed);
      }
    }
    return events.sort(compareProgressEvents);
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }

  private eventKey(invocationId: string) {
    return `${this.keyPrefix}:invocation:${invocationId}:events`;
  }

  private sequenceKey(invocationId: string) {
    return `${this.keyPrefix}:invocation:${invocationId}:sequence`;
  }
}

class LocalBotProgressStore implements BotProgressStore {
  private readonly eventsByInvocation = new Map<string, BotInvocationProgressEventPublic[]>();
  private readonly sequenceByInvocation = new Map<string, number>();
  private readonly expiresAtByInvocation = new Map<string, number>();
  private readonly ttlMs: number;
  private readonly maxEvents: number;

  constructor(options: { ttlSeconds?: number; maxEvents?: number } = {}) {
    this.ttlMs = (options.ttlSeconds ?? DEFAULT_PROGRESS_TTL_SECONDS) * 1000;
    this.maxEvents = options.maxEvents ?? DEFAULT_PROGRESS_MAX_EVENTS;
  }

  async append(input: ProgressEventInput): Promise<BotInvocationProgressEventPublic> {
    this.pruneExpired();
    const sequence = (this.sequenceByInvocation.get(input.invocationId) ?? 0) + 1;
    this.sequenceByInvocation.set(input.invocationId, sequence);
    this.expiresAtByInvocation.set(input.invocationId, Date.now() + this.ttlMs);
    const event: BotInvocationProgressEventPublic = {
      id: crypto.randomUUID(),
      invocationId: input.invocationId,
      botId: input.botId,
      conversationId: input.conversationId,
      threadId: input.threadId,
      sequence,
      type: input.type,
      status: input.status,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      label: input.label,
      preview: input.preview,
      payload: input.payload,
      occurredAt: input.occurredAt.toISOString(),
      createdAt: new Date().toISOString(),
    };
    const events = this.eventsByInvocation.get(input.invocationId) ?? [];
    events.push(event);
    this.eventsByInvocation.set(input.invocationId, events.slice(-this.maxEvents));
    return event;
  }

  async listForInvocations(invocationIds: string[]): Promise<BotInvocationProgressEventPublic[]> {
    this.pruneExpired();
    return invocationIds
      .flatMap((invocationId) => this.eventsByInvocation.get(invocationId) ?? [])
      .sort(compareProgressEvents);
  }

  private pruneExpired() {
    const now = Date.now();
    for (const [invocationId, expiresAt] of this.expiresAtByInvocation) {
      if (expiresAt > now) continue;
      this.expiresAtByInvocation.delete(invocationId);
      this.sequenceByInvocation.delete(invocationId);
      this.eventsByInvocation.delete(invocationId);
    }
  }
}

class ResilientBotProgressStore implements BotProgressStore {
  private readonly redis: BotProgressStore;
  private readonly fallback: BotProgressStore;
  private warned = false;

  constructor(redis: BotProgressStore, fallback: BotProgressStore) {
    this.redis = redis;
    this.fallback = fallback;
  }

  async append(input: ProgressEventInput): Promise<BotInvocationProgressEventPublic> {
    try {
      return await this.redis.append(input);
    } catch (error) {
      this.warn(error);
      return this.fallback.append(input);
    }
  }

  async listForInvocations(invocationIds: string[]): Promise<BotInvocationProgressEventPublic[]> {
    try {
      return await this.redis.listForInvocations(invocationIds);
    } catch (error) {
      this.warn(error);
      return this.fallback.listForInvocations(invocationIds);
    }
  }

  async close(): Promise<void> {
    await Promise.allSettled([this.redis.close?.(), this.fallback.close?.()]);
  }

  private warn(error: unknown) {
    if (this.warned) return;
    this.warned = true;
    botProgressLog.warn(
      { err: error },
      "Falling back to in-memory Hermes progress store",
    );
  }
}

let progressStore: BotProgressStore | null = null;

export function getBotProgressStore(): BotProgressStore {
  progressStore ??= new ResilientBotProgressStore(
    new RedisBotProgressStore(),
    new LocalBotProgressStore(),
  );
  return progressStore;
}

export async function setBotProgressStoreForTests(store: BotProgressStore): Promise<void> {
  await progressStore?.close?.();
  progressStore = store;
}

export function createLocalBotProgressStoreForTests(
  options: { ttlSeconds?: number; maxEvents?: number } = {},
): BotProgressStore {
  return new LocalBotProgressStore(options);
}

export async function closeBotProgressStoreForTests(): Promise<void> {
  await progressStore?.close?.();
  progressStore = null;
}

async function connectRedisIfNeeded(redis: Redis): Promise<void> {
  if (redis.status === "ready" || redis.status === "connecting" || redis.status === "connect") return;
  await redis.connect();
}

function parseProgressEvent(raw: unknown): BotInvocationProgressEventPublic | null {
  if (typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw);
    return isProgressEvent(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isProgressEvent(value: unknown): value is BotInvocationProgressEventPublic {
  return !!(
    value &&
    typeof value === "object" &&
    typeof (value as BotInvocationProgressEventPublic).id === "string" &&
    typeof (value as BotInvocationProgressEventPublic).invocationId === "string" &&
    typeof (value as BotInvocationProgressEventPublic).sequence === "number" &&
    typeof (value as BotInvocationProgressEventPublic).type === "string"
  );
}

function compareProgressEvents(
  a: BotInvocationProgressEventPublic,
  b: BotInvocationProgressEventPublic,
) {
  if (a.invocationId !== b.invocationId) return a.invocationId.localeCompare(b.invocationId);
  if (a.sequence !== b.sequence) return a.sequence - b.sequence;
  return Date.parse(a.createdAt) - Date.parse(b.createdAt);
}

function readPositiveInt(value: string | undefined, fallback: number) {
  const parsed = value ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
