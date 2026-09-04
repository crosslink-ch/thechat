import crypto from "node:crypto";
import Redis from "ioredis";

export const HERMES_PROXY_TICKET_TTL_MS = 30_000;
const TICKET_BYTES = 32;
const TICKET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface HermesProxyGrant {
  version: 1;
  botId: string;
  conversationId: string;
  endpoint: string;
  gatewayTokenEncrypted: string;
  userId: string;
  issuedAt: number;
  expiresAt: number;
}

export type HermesProxyGrantInput = Omit<
  HermesProxyGrant,
  "issuedAt" | "expiresAt"
>;

export interface IssuedHermesProxyTicket {
  ticket: string;
  expiresAt: number;
}

export interface HermesProxyTicketStore {
  issue(
    grant: HermesProxyGrantInput,
    ttlMs?: number,
  ): Promise<IssuedHermesProxyTicket>;
  consume(ticket: string): Promise<HermesProxyGrant | null>;
  close?(): Promise<void>;
}

interface ClockOptions {
  now?: () => number;
}

function newTicket(): string {
  return crypto.randomBytes(TICKET_BYTES).toString("base64url");
}

function ticketKey(ticket: string, prefix: string): string {
  const digest = crypto.createHash("sha256").update(ticket).digest("hex");
  return `${prefix}:hermes-proxy-ticket:${digest}`;
}

function completeGrant(
  grant: HermesProxyGrantInput,
  issuedAt: number,
  ttlMs: number,
): HermesProxyGrant {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new Error("Hermes proxy ticket TTL must be positive");
  }
  return {
    ...grant,
    version: 1,
    issuedAt,
    expiresAt: issuedAt + ttlMs,
  };
}

function parseGrant(raw: string): HermesProxyGrant | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const grant = value as Partial<HermesProxyGrant>;
  if (
    grant.version !== 1 ||
    typeof grant.botId !== "string" ||
    typeof grant.conversationId !== "string" ||
    typeof grant.endpoint !== "string" ||
    typeof grant.gatewayTokenEncrypted !== "string" ||
    typeof grant.userId !== "string" ||
    typeof grant.issuedAt !== "number" ||
    typeof grant.expiresAt !== "number"
  ) {
    return null;
  }
  return grant as HermesProxyGrant;
}

export class InMemoryHermesProxyTicketStore
  implements HermesProxyTicketStore
{
  private readonly entries = new Map<string, HermesProxyGrant>();
  private readonly now: () => number;

  constructor(options: ClockOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  async issue(
    grant: HermesProxyGrantInput,
    ttlMs = HERMES_PROXY_TICKET_TTL_MS,
  ): Promise<IssuedHermesProxyTicket> {
    const issuedAt = this.now();
    const complete = completeGrant(grant, issuedAt, ttlMs);
    let ticket = newTicket();
    while (this.entries.has(ticketKey(ticket, "memory"))) {
      ticket = newTicket();
    }
    this.entries.set(ticketKey(ticket, "memory"), complete);
    return { ticket, expiresAt: complete.expiresAt };
  }

  async consume(ticket: string): Promise<HermesProxyGrant | null> {
    if (!TICKET_PATTERN.test(ticket)) return null;
    const key = ticketKey(ticket, "memory");
    const grant = this.entries.get(key) ?? null;
    this.entries.delete(key);
    if (!grant || grant.expiresAt <= this.now()) return null;
    return grant;
  }
}

export interface RedisHermesProxyTicketStoreOptions extends ClockOptions {
  redis?: Redis;
  redisKeyPrefix?: string;
  redisUrl?: string;
}

export class RedisHermesProxyTicketStore implements HermesProxyTicketStore {
  private readonly now: () => number;
  private readonly prefix: string;
  private readonly redis: Redis;
  private readonly ownsRedis: boolean;

  constructor(options: RedisHermesProxyTicketStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.prefix = options.redisKeyPrefix ??
      process.env.REDIS_KEY_PREFIX ??
      "thechat";
    this.ownsRedis = !options.redis;
    this.redis = options.redis ?? new Redis(
      options.redisUrl ?? process.env.REDIS_URL ?? "redis://localhost:16380",
      {
        lazyConnect: true,
        maxRetriesPerRequest: 1,
      },
    );
  }

  async issue(
    grant: HermesProxyGrantInput,
    ttlMs = HERMES_PROXY_TICKET_TTL_MS,
  ): Promise<IssuedHermesProxyTicket> {
    const issuedAt = this.now();
    const complete = completeGrant(grant, issuedAt, ttlMs);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const ticket = newTicket();
      const result = await this.redis.set(
        ticketKey(ticket, this.prefix),
        JSON.stringify(complete),
        "PX",
        ttlMs,
        "NX",
      );
      if (result === "OK") {
        return { ticket, expiresAt: complete.expiresAt };
      }
    }
    throw new Error("Could not allocate a unique Hermes proxy ticket");
  }

  async consume(ticket: string): Promise<HermesProxyGrant | null> {
    if (!TICKET_PATTERN.test(ticket)) return null;
    const raw = await this.redis.call(
      "GETDEL",
      ticketKey(ticket, this.prefix),
    );
    if (typeof raw !== "string") return null;
    const grant = parseGrant(raw);
    if (!grant || grant.expiresAt <= this.now()) return null;
    return grant;
  }

  async close(): Promise<void> {
    if (this.ownsRedis) {
      await this.redis.quit();
    }
  }
}

let defaultStore: HermesProxyTicketStore | null = null;

export function getHermesProxyTicketStore(): HermesProxyTicketStore {
  defaultStore ??= new RedisHermesProxyTicketStore();
  return defaultStore;
}

export async function setHermesProxyTicketStoreForTests(
  store: HermesProxyTicketStore | null,
): Promise<void> {
  if (defaultStore && defaultStore !== store) {
    await defaultStore.close?.();
  }
  defaultStore = store;
}
