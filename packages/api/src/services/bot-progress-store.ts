import crypto from "crypto";
import Redis from "ioredis";
import type { BotInvocationProgressEventPublic } from "@thechat/shared";
import { log } from "../logging";

const botProgressLog = log.child({ component: "bot-progress-store" });

const DEFAULT_PROGRESS_TTL_SECONDS = 60 * 60;
const DEFAULT_PROGRESS_MAX_EVENTS = 100;
const DEFAULT_PROGRESS_ACTIVITY_TIMEOUT_MS = 30_000;

const APPEND_IDEMPOTENT_REQUEST_SCRIPT = `
local existing = redis.call('HGET', KEYS[1], ARGV[1])
if existing then
  redis.call('EXPIRE', KEYS[1], ARGV[4])
  redis.call('EXPIRE', KEYS[2], ARGV[4])
  redis.call('EXPIRE', KEYS[3], ARGV[4])
  redis.call('EXPIRE', KEYS[4], ARGV[4])
  redis.call('SET', KEYS[5], ARGV[5], 'EX', ARGV[4])
  redis.call('SADD', KEYS[6], ARGV[6])
  redis.call('EXPIRE', KEYS[6], ARGV[4])
  return existing
end
local sequence = redis.call('INCR', KEYS[3])
local event = cjson.decode(ARGV[2])
event.sequence = sequence
local encoded = cjson.encode(event)
redis.call('RPUSH', KEYS[2], encoded)
redis.call('LTRIM', KEYS[2], -tonumber(ARGV[3]), -1)
redis.call('HSET', KEYS[1], ARGV[1], encoded)
redis.call('HSET', KEYS[4], ARGV[1], encoded)
redis.call('EXPIRE', KEYS[1], ARGV[4])
redis.call('EXPIRE', KEYS[2], ARGV[4])
redis.call('EXPIRE', KEYS[3], ARGV[4])
redis.call('EXPIRE', KEYS[4], ARGV[4])
redis.call('SET', KEYS[5], ARGV[5], 'EX', ARGV[4])
redis.call('SADD', KEYS[6], ARGV[6])
redis.call('EXPIRE', KEYS[6], ARGV[4])
return encoded
`;

export function botProgressRetentionMs() {
  return readPositiveInt(
    process.env.HERMES_PROGRESS_TTL_SECONDS,
    DEFAULT_PROGRESS_TTL_SECONDS,
  ) * 1000;
}

export interface ProgressEventInput {
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
  touch(input: { invocationId: string; conversationId: string }): Promise<void>;
  listForConversation(
    conversationId: string,
    candidateInvocationIds?: string[],
  ): Promise<BotInvocationProgressEventPublic[]>;
  clear(input: { invocationId: string; conversationId: string }): Promise<void>;
  close?(): Promise<void>;
}

class RedisBotProgressStore implements BotProgressStore {
  private readonly redis: Redis;
  private readonly keyPrefix: string;
  private readonly ttlSeconds: number;
  private readonly maxEvents: number;
  private readonly activityTimeoutMs: number;
  private readonly now: () => number;

  constructor(options: {
    redisUrl?: string;
    redisKeyPrefix?: string;
    ttlSeconds?: number;
    maxEvents?: number;
    activityTimeoutMs?: number;
    now?: () => number;
  } = {}) {
    const redisUrl = options.redisUrl ?? process.env.REDIS_URL ?? "redis://localhost:16380";
    this.keyPrefix = `${options.redisKeyPrefix ?? process.env.REDIS_KEY_PREFIX ?? "thechat"}:bot-progress`;
    this.ttlSeconds = options.ttlSeconds ?? botProgressRetentionMs() / 1000;
    this.maxEvents = options.maxEvents ?? readPositiveInt(
      process.env.HERMES_PROGRESS_MAX_EVENTS,
      DEFAULT_PROGRESS_MAX_EVENTS,
    );
    this.activityTimeoutMs = options.activityTimeoutMs ?? readPositiveInt(
      process.env.HERMES_PROGRESS_ACTIVITY_TIMEOUT_MS,
      DEFAULT_PROGRESS_ACTIVITY_TIMEOUT_MS,
    );
    this.now = options.now ?? Date.now;
    this.redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: null });
    this.redis.on("error", (error) => {
      botProgressLog.warn({ err: error }, "Redis bot progress store error");
    });
  }

  async append(input: ProgressEventInput): Promise<BotInvocationProgressEventPublic> {
    await connectRedisIfNeeded(this.redis);
    const sequenceKey = this.sequenceKey(input.invocationId);
    const eventKey = this.eventKey(input.invocationId);
    const now = new Date(this.now());
    const requestIdentity = interactionRequestIdentity(input);
    const event: BotInvocationProgressEventPublic = {
      id: requestIdentity
        ? stableInteractionEventId(input.invocationId, requestIdentity)
        : crypto.randomUUID(),
      invocationId: input.invocationId,
      botId: input.botId,
      conversationId: input.conversationId,
      threadId: input.threadId,
      sequence: 0,
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

    if (requestIdentity) {
      const raw = await this.redis.eval(
        APPEND_IDEMPOTENT_REQUEST_SCRIPT,
        6,
        this.requestIdentityKey(input.invocationId),
        eventKey,
        sequenceKey,
        this.pendingRequestKey(input.invocationId),
        this.activityKey(input.invocationId),
        this.conversationKey(input.conversationId),
        requestIdentity,
        JSON.stringify(event),
        String(this.maxEvents),
        String(this.ttlSeconds),
        String(now.getTime()),
        input.invocationId,
      );
      const parsed = parseProgressEvent(raw);
      if (!parsed) throw new Error("Redis returned invalid idempotent progress event");
      return parsed;
    }

    const sequence = await this.redis.incr(sequenceKey);
    event.sequence = sequence;

    const pipeline = this.redis.pipeline();
    pipeline.rpush(eventKey, JSON.stringify(event));
    pipeline.ltrim(eventKey, -this.maxEvents, -1);
    pipeline.expire(eventKey, this.ttlSeconds);
    pipeline.expire(sequenceKey, this.ttlSeconds);
    pipeline.set(this.activityKey(input.invocationId), String(now.getTime()), "EX", this.ttlSeconds);
    pipeline.sadd(this.conversationKey(input.conversationId), input.invocationId);
    pipeline.expire(this.conversationKey(input.conversationId), this.ttlSeconds);
    for (const identity of await this.pendingResolutionIdentities(input)) {
      pipeline.hdel(this.pendingRequestKey(input.invocationId), identity);
    }
    pipeline.expire(this.pendingRequestKey(input.invocationId), this.ttlSeconds);
    const pipelineResult = await pipeline.exec();
    throwOnRedisPipelineError(pipelineResult);

    return event;
  }

  async touch(input: { invocationId: string; conversationId: string }): Promise<void> {
    await connectRedisIfNeeded(this.redis);
    const pipeline = this.redis.pipeline();
    pipeline.set(this.activityKey(input.invocationId), String(this.now()), "EX", this.ttlSeconds);
    pipeline.expire(this.eventKey(input.invocationId), this.ttlSeconds);
    pipeline.expire(this.sequenceKey(input.invocationId), this.ttlSeconds);
    pipeline.expire(this.requestIdentityKey(input.invocationId), this.ttlSeconds);
    pipeline.expire(this.pendingRequestKey(input.invocationId), this.ttlSeconds);
    pipeline.sadd(this.conversationKey(input.conversationId), input.invocationId);
    pipeline.expire(this.conversationKey(input.conversationId), this.ttlSeconds);
    const pipelineResult = await pipeline.exec();
    throwOnRedisPipelineError(pipelineResult);
  }

  async listForConversation(
    conversationId: string,
    candidateInvocationIds: string[] = [],
  ): Promise<BotInvocationProgressEventPublic[]> {
    await connectRedisIfNeeded(this.redis);
    const indexedInvocationIds = await this.redis.smembers(
      this.conversationKey(conversationId),
    );
    const invocationIds = Array.from(
      new Set([...indexedInvocationIds, ...candidateInvocationIds]),
    );
    if (invocationIds.length === 0) return [];
    const pipeline = this.redis.pipeline();
    for (const invocationId of invocationIds) {
      pipeline.lrange(this.eventKey(invocationId), 0, -1);
      pipeline.hvals(this.pendingRequestKey(invocationId));
      pipeline.get(this.activityKey(invocationId));
    }
    const results = await pipeline.exec();
    throwOnRedisPipelineError(results);
    const events: BotInvocationProgressEventPublic[] = [];
    const staleInvocationIds: string[] = [];
    const backfillActivities = new Map<string, number>();
    const now = this.now();
    for (let index = 0; index < invocationIds.length; index += 1) {
      const eventResult = results?.[index * 3];
      const pendingResult = results?.[index * 3 + 1];
      const activityResult = results?.[index * 3 + 2];
      const rawEvents = eventResult && !eventResult[0] && Array.isArray(eventResult[1])
        ? eventResult[1]
        : [];
      const rawPending = pendingResult && !pendingResult[0] && Array.isArray(pendingResult[1])
        ? pendingResult[1]
        : [];
      const invocationEvents: BotInvocationProgressEventPublic[] = [];
      for (const raw of [...rawEvents, ...rawPending]) {
        const parsed = parseProgressEvent(raw);
        if (parsed && !invocationEvents.some((event) => event.id === parsed.id)) {
          invocationEvents.push(parsed);
        }
      }
      invocationEvents.sort(compareProgressEvents);
      const rawActivityAt = activityResult && !activityResult[0]
        ? activityResult[1]
        : null;
      const activityAt = typeof rawActivityAt === "string"
        ? Number(rawActivityAt)
        : Number.NaN;
      const latestEventAt = latestProgressTimestamp(invocationEvents);
      const effectiveActivityAt = Number.isFinite(activityAt)
        ? activityAt
        : latestEventAt;
      const invocationId = invocationIds[index]!;
      if (invocationEvents.length === 0 && !Number.isFinite(activityAt)) {
        staleInvocationIds.push(invocationId);
        continue;
      }
      if (!indexedInvocationIds.includes(invocationId) && invocationEvents.length > 0) {
        backfillActivities.set(invocationId, effectiveActivityAt);
      }
      if (
        isRecentlyActive(effectiveActivityAt, now, this.activityTimeoutMs) ||
        hasUnresolvedInteraction(invocationEvents)
      ) {
        events.push(...invocationEvents);
      }
    }
    if (staleInvocationIds.length > 0) {
      await this.redis.srem(this.conversationKey(conversationId), ...staleInvocationIds);
    }
    if (backfillActivities.size > 0) {
      const backfill = this.redis.pipeline();
      backfill.sadd(this.conversationKey(conversationId), ...backfillActivities.keys());
      backfill.expire(this.conversationKey(conversationId), this.ttlSeconds);
      for (const [invocationId, activityAt] of backfillActivities) {
        if (Number.isFinite(activityAt)) {
          backfill.set(this.activityKey(invocationId), String(activityAt), "EX", this.ttlSeconds);
        }
      }
      throwOnRedisPipelineError(await backfill.exec());
    }
    return events.sort(compareProgressEvents);
  }

  async clear(input: { invocationId: string; conversationId: string }): Promise<void> {
    await connectRedisIfNeeded(this.redis);
    const pipeline = this.redis.pipeline();
    pipeline.del(
      this.eventKey(input.invocationId),
      this.sequenceKey(input.invocationId),
      this.activityKey(input.invocationId),
      this.requestIdentityKey(input.invocationId),
      this.pendingRequestKey(input.invocationId),
    );
    pipeline.srem(this.conversationKey(input.conversationId), input.invocationId);
    const pipelineResult = await pipeline.exec();
    throwOnRedisPipelineError(pipelineResult);
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

  private activityKey(invocationId: string) {
    return `${this.keyPrefix}:invocation:${invocationId}:activity`;
  }

  private requestIdentityKey(invocationId: string) {
    return `${this.keyPrefix}:invocation:${invocationId}:request-identities`;
  }

  private pendingRequestKey(invocationId: string) {
    return `${this.keyPrefix}:invocation:${invocationId}:pending-requests`;
  }

  private conversationKey(conversationId: string) {
    return `${this.keyPrefix}:conversation:${conversationId}:invocations`;
  }

  private async pendingResolutionIdentities(input: ProgressEventInput) {
    const resolution = interactionResolution(input);
    if (!resolution) return [];
    if (resolution.requestId) {
      return [`${resolution.requestType}:${resolution.requestId}`];
    }

    const pending = await this.redis.hgetall(
      this.pendingRequestKey(input.invocationId),
    );
    const candidates = Object.entries(pending)
      .map(([identity, raw]) => ({ identity, event: parseProgressEvent(raw) }))
      .filter(
        (item): item is { identity: string; event: BotInvocationProgressEventPublic } =>
          item.event !== null &&
          item.event.type === resolution.requestType &&
          (!resolution.sessionKey ||
            stringField(item.event.payload, "sessionKey") === resolution.sessionKey),
      )
      .sort((left, right) => compareProgressEvents(left.event, right.event));
    const count = resolution.resolveAll
      ? candidates.length
      : Math.max(1, resolution.resolvedCount);
    return candidates.slice(0, count).map((candidate) => candidate.identity);
  }
}

class LocalBotProgressStore implements BotProgressStore {
  private readonly eventsByInvocation = new Map<string, BotInvocationProgressEventPublic[]>();
  private readonly sequenceByInvocation = new Map<string, number>();
  private readonly expiresAtByInvocation = new Map<string, number>();
  private readonly activityAtByInvocation = new Map<string, number>();
  private readonly invocationIdsByConversation = new Map<string, Set<string>>();
  private readonly conversationByInvocation = new Map<string, string>();
  private readonly requestEventsByInvocation = new Map<
    string,
    Map<string, BotInvocationProgressEventPublic>
  >();
  private readonly ttlMs: number;
  private readonly maxEvents: number;
  private readonly activityTimeoutMs: number;
  private readonly now: () => number;

  constructor(options: {
    ttlSeconds?: number;
    maxEvents?: number;
    activityTimeoutMs?: number;
    now?: () => number;
  } = {}) {
    this.ttlMs = (options.ttlSeconds ?? DEFAULT_PROGRESS_TTL_SECONDS) * 1000;
    this.maxEvents = options.maxEvents ?? DEFAULT_PROGRESS_MAX_EVENTS;
    this.activityTimeoutMs = options.activityTimeoutMs ?? DEFAULT_PROGRESS_ACTIVITY_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
  }

  async append(input: ProgressEventInput): Promise<BotInvocationProgressEventPublic> {
    this.pruneExpired();
    const now = this.now();
    this.indexInvocation(input.invocationId, input.conversationId, now);
    const requestIdentity = interactionRequestIdentity(input);
    if (requestIdentity) {
      const existing = this.requestEventsByInvocation
        .get(input.invocationId)
        ?.get(requestIdentity);
      if (existing) return existing;
    }
    const sequence = (this.sequenceByInvocation.get(input.invocationId) ?? 0) + 1;
    this.sequenceByInvocation.set(input.invocationId, sequence);
    const event: BotInvocationProgressEventPublic = {
      id: requestIdentity
        ? stableInteractionEventId(input.invocationId, requestIdentity)
        : crypto.randomUUID(),
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
      createdAt: new Date(now).toISOString(),
    };
    if (requestIdentity) {
      const requestEvents = this.requestEventsByInvocation.get(input.invocationId) ??
        new Map<string, BotInvocationProgressEventPublic>();
      requestEvents.set(requestIdentity, event);
      this.requestEventsByInvocation.set(input.invocationId, requestEvents);
    }
    const events = this.eventsByInvocation.get(input.invocationId) ?? [];
    events.push(event);
    this.eventsByInvocation.set(
      input.invocationId,
      compactProgressEvents(events, this.maxEvents),
    );
    return event;
  }

  async touch(input: { invocationId: string; conversationId: string }): Promise<void> {
    this.pruneExpired();
    this.indexInvocation(input.invocationId, input.conversationId, this.now());
  }

  async listForConversation(
    conversationId: string,
    _candidateInvocationIds: string[] = [],
  ): Promise<BotInvocationProgressEventPublic[]> {
    this.pruneExpired();
    const now = this.now();
    return Array.from(this.invocationIdsByConversation.get(conversationId) ?? [])
      .flatMap((invocationId) => {
        const events = this.eventsByInvocation.get(invocationId) ?? [];
        const activityAt = this.activityAtByInvocation.get(invocationId) ?? Number.NaN;
        return isRecentlyActive(activityAt, now, this.activityTimeoutMs) ||
          hasUnresolvedInteraction(events)
          ? events
          : [];
      })
      .sort(compareProgressEvents);
  }

  async clear(input: { invocationId: string; conversationId: string }): Promise<void> {
    this.deleteInvocation(input.invocationId, input.conversationId);
  }

  private indexInvocation(invocationId: string, conversationId: string, now: number) {
    const previousConversationId = this.conversationByInvocation.get(invocationId);
    if (previousConversationId && previousConversationId !== conversationId) {
      this.invocationIdsByConversation.get(previousConversationId)?.delete(invocationId);
    }
    const invocationIds = this.invocationIdsByConversation.get(conversationId) ?? new Set<string>();
    invocationIds.add(invocationId);
    this.invocationIdsByConversation.set(conversationId, invocationIds);
    this.conversationByInvocation.set(invocationId, conversationId);
    this.activityAtByInvocation.set(invocationId, now);
    this.expiresAtByInvocation.set(invocationId, now + this.ttlMs);
  }

  private pruneExpired() {
    const now = this.now();
    for (const [invocationId, expiresAt] of this.expiresAtByInvocation) {
      if (expiresAt > now) continue;
      this.deleteInvocation(invocationId);
    }
  }

  private deleteInvocation(invocationId: string, conversationId?: string) {
    const indexedConversationId = conversationId ?? this.conversationByInvocation.get(invocationId);
    if (indexedConversationId) {
      const invocationIds = this.invocationIdsByConversation.get(indexedConversationId);
      invocationIds?.delete(invocationId);
      if (invocationIds?.size === 0) this.invocationIdsByConversation.delete(indexedConversationId);
    }
    this.conversationByInvocation.delete(invocationId);
    this.activityAtByInvocation.delete(invocationId);
    this.expiresAtByInvocation.delete(invocationId);
    this.sequenceByInvocation.delete(invocationId);
    this.requestEventsByInvocation.delete(invocationId);
    this.eventsByInvocation.delete(invocationId);
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
      const event = await this.redis.append(input);
      // A primary append is also activity for any history accepted by the
      // fallback during an earlier outage.
      await this.fallback.touch({
        invocationId: input.invocationId,
        conversationId: input.conversationId,
      });
      return event;
    } catch (error) {
      this.warn(error);
      return this.fallback.append(input);
    }
  }

  async touch(input: { invocationId: string; conversationId: string }): Promise<void> {
    try {
      await this.redis.touch(input);
    } catch (error) {
      this.warn(error);
    }
    // Keep any events accepted by the fallback alive across Redis recovery.
    await this.fallback.touch(input);
  }

  async listForConversation(
    conversationId: string,
    candidateInvocationIds: string[] = [],
  ): Promise<BotInvocationProgressEventPublic[]> {
    let redisEvents: BotInvocationProgressEventPublic[] = [];
    try {
      redisEvents = await this.redis.listForConversation(
        conversationId,
        candidateInvocationIds,
      );
    } catch (error) {
      this.warn(error);
    }
    const fallbackEvents = await this.fallback.listForConversation(
      conversationId,
      candidateInvocationIds,
    );
    return mergeProgressEventSets(redisEvents, fallbackEvents);
  }

  async clear(input: { invocationId: string; conversationId: string }): Promise<void> {
    let redisError: unknown = null;
    try {
      await this.redis.clear(input);
    } catch (error) {
      this.warn(error);
      redisError = error;
    }
    // The fallback may contain events from an earlier Redis outage. Always
    // clear both stores so terminal activity cannot reappear during a later
    // fallback.
    await this.fallback.clear(input);
    // Do not acknowledge a terminal callback while the primary copy may still
    // exist. Hermes can retry the idempotent callback once Redis recovers.
    if (redisError) throw redisError;
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
  options: {
    ttlSeconds?: number;
    maxEvents?: number;
    activityTimeoutMs?: number;
    now?: () => number;
  } = {},
): BotProgressStore {
  return new LocalBotProgressStore(options);
}

export function createRedisBotProgressStoreForTests(
  options: {
    redisUrl: string;
    redisKeyPrefix?: string;
    ttlSeconds?: number;
    maxEvents?: number;
    activityTimeoutMs?: number;
    now?: () => number;
  },
): BotProgressStore {
  return new RedisBotProgressStore(options);
}

export function createResilientBotProgressStoreForTests(
  primary: BotProgressStore,
  fallback: BotProgressStore,
): BotProgressStore {
  return new ResilientBotProgressStore(primary, fallback);
}

export async function closeBotProgressStoreForTests(): Promise<void> {
  await progressStore?.close?.();
  progressStore = null;
}

async function connectRedisIfNeeded(redis: Redis): Promise<void> {
  if (redis.status === "ready" || redis.status === "connecting" || redis.status === "connect") return;
  await redis.connect();
}

function throwOnRedisPipelineError(
  results: Array<[Error | null, unknown]> | null,
) {
  if (!results) throw new Error("Redis pipeline returned no results");
  const failed = results.find(([error]) => error !== null);
  if (failed?.[0]) throw failed[0];
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

function latestProgressTimestamp(events: BotInvocationProgressEventPublic[]) {
  return events.reduce((latest, event) => {
    const timestamp = Date.parse(event.createdAt);
    return Number.isFinite(timestamp) ? Math.max(latest, timestamp) : latest;
  }, Number.NEGATIVE_INFINITY);
}

function mergeProgressEventSets(
  ...groups: BotInvocationProgressEventPublic[][]
) {
  const nonEmptyGroups = groups.filter((group) => group.length > 0);
  if (nonEmptyGroups.length <= 1) {
    return [...(nonEmptyGroups[0] ?? [])].sort(compareProgressEvents);
  }
  const byId = new Map<string, BotInvocationProgressEventPublic>();
  for (const event of groups.flat()) byId.set(event.id, event);
  // Redis and the local fallback have independent sequence counters. During
  // recovery, reconcile the combined timeline by event time before assigning
  // a monotonic snapshot sequence.
  return Array.from(byId.values())
    .sort(compareProgressEventsByTime)
    .map((event, index) => ({ ...event, sequence: index + 1 }));
}

function compareProgressEventsByTime(
  a: BotInvocationProgressEventPublic,
  b: BotInvocationProgressEventPublic,
) {
  const timeDelta = Date.parse(a.createdAt) - Date.parse(b.createdAt);
  if (timeDelta !== 0) return timeDelta;
  if (a.sequence !== b.sequence) return a.sequence - b.sequence;
  return a.id.localeCompare(b.id);
}

function compareProgressEvents(
  a: BotInvocationProgressEventPublic,
  b: BotInvocationProgressEventPublic,
) {
  if (a.invocationId !== b.invocationId) return a.invocationId.localeCompare(b.invocationId);
  if (a.sequence !== b.sequence) return a.sequence - b.sequence;
  return Date.parse(a.createdAt) - Date.parse(b.createdAt);
}

function isRecentlyActive(activityAt: number, now: number, timeoutMs: number) {
  return Number.isFinite(activityAt) && now - activityAt <= timeoutMs;
}

function hasUnresolvedInteraction(events: BotInvocationProgressEventPublic[]) {
  return unresolvedInteractionRequestIds(events).size > 0;
}

function compactProgressEvents(
  events: BotInvocationProgressEventPublic[],
  maxEvents: number,
) {
  if (events.length <= maxEvents) return events;
  const pendingIds = unresolvedInteractionRequestIds(events);
  const compactable = events.filter((event) => !pendingIds.has(event.id));
  const retainedCompactableIds = new Set(
    compactable.slice(-maxEvents).map((event) => event.id),
  );
  return events.filter(
    (event) => pendingIds.has(event.id) || retainedCompactableIds.has(event.id),
  );
}

function unresolvedInteractionRequestIds(
  events: BotInvocationProgressEventPublic[],
) {
  const pendingByType = new Map<string, BotInvocationProgressEventPublic[]>([
    ["approval", []],
    ["clarify", []],
  ]);
  for (const event of [...events].sort(compareProgressEvents)) {
    const requestKind = event.type === "approval.request"
      ? "approval"
      : event.type === "clarify.request"
        ? "clarify"
        : null;
    if (requestKind) {
      pendingByType.get(requestKind)!.push(event);
      continue;
    }
    const resolutionKind = event.type === "approval.resolved"
      ? "approval"
      : event.type === "clarify.resolved"
        ? "clarify"
        : null;
    if (!resolutionKind) continue;
    const pending = pendingByType.get(resolutionKind)!;
    const requestId = stringField(event.payload, "requestId");
    const sessionKey = stringField(event.payload, "sessionKey");
    const candidates = requestId
      ? pending.filter(
          (request) => stringField(request.payload, "requestId") === requestId,
        )
      : pending.filter(
          (request) =>
            request.invocationId === event.invocationId &&
            (!sessionKey ||
              !stringField(request.payload, "sessionKey") ||
              stringField(request.payload, "sessionKey") === sessionKey),
        );
    const requestedCount = numberField(event.payload, "resolvedCount");
    const count = resolutionKind === "approval" && event.payload?.resolveAll === true
      ? candidates.length
      : resolutionKind === "approval"
        ? Math.max(1, requestedCount ?? 1)
        : 1;
    const resolved = candidates.slice(0, count);
    for (const request of resolved) {
      pending.splice(pending.indexOf(request), 1);
    }
  }
  return new Set(
    Array.from(pendingByType.values())
      .flat()
      .map((event) => event.id),
  );
}

function interactionRequestIdentity(input: ProgressEventInput) {
  if (input.type !== "approval.request" && input.type !== "clarify.request") {
    return null;
  }
  const requestId = stringField(input.payload, "requestId");
  return requestId ? `${input.type}:${requestId}` : null;
}

function interactionResolution(input: ProgressEventInput) {
  const requestType = input.type === "approval.resolved"
    ? "approval.request"
    : input.type === "clarify.resolved"
      ? "clarify.request"
      : null;
  if (!requestType) return null;
  return {
    requestType,
    requestId: stringField(input.payload, "requestId"),
    sessionKey: stringField(input.payload, "sessionKey"),
    resolveAll: input.type === "approval.resolved" && input.payload?.resolveAll === true,
    resolvedCount: numberField(input.payload, "resolvedCount") ?? 1,
  };
}

function stableInteractionEventId(invocationId: string, requestIdentity: string) {
  const hex = crypto
    .createHash("sha256")
    .update(`${invocationId}\0${requestIdentity}`)
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function numberField(source: Record<string, unknown> | null, key: string) {
  const value = source?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringField(source: Record<string, unknown> | null, key: string) {
  const value = source?.[key];
  return typeof value === "string" ? value.trim() : "";
}

function readPositiveInt(value: string | undefined, fallback: number) {
  const parsed = value ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
