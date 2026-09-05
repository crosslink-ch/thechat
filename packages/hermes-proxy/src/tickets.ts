import crypto from "node:crypto";
import Redis from "ioredis";

export const HERMES_PROXY_TICKET_TTL_MS = 30_000;
const TICKET_BYTES = 32;
const TICKET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface HermesProxyGrant {
  version: 2;
  policyRevision: string;
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
  publishPolicyRevision(botId: string, revision: string): Promise<void>;
  isCurrent(
    grant: Pick<HermesProxyGrant, "botId" | "policyRevision">,
  ): Promise<boolean>;
  close?(): Promise<void>;
}

interface ClockOptions {
  now?: () => number;
}

function validRevision(value: unknown): value is string {
  return typeof value === "string" && /^[1-9][0-9]{0,9}$/.test(value);
}

function policyKey(botId: string, prefix: string): string {
  return `${prefix}:hermes-proxy-policy:${botId}`;
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
  if (grant.version !== 2 || !validRevision(grant.policyRevision))
    throw new Error("Invalid Hermes proxy grant");
  return {
    ...grant,
    version: 2,
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
    grant.version !== 2 ||
    !validRevision(grant.policyRevision) ||
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

export class InMemoryHermesProxyTicketStore implements HermesProxyTicketStore {
  private readonly entries = new Map<string, HermesProxyGrant>();
  private readonly revisions = new Map<string, string>();
  private readonly now: () => number;

  async publishPolicyRevision(botId: string, revision: string): Promise<void> {
    if (
      !validRevision(revision) ||
      Number(this.revisions.get(botId) ?? 0) > Number(revision)
    )
      throw new Error("Stale Hermes policy revision");
    this.revisions.set(botId, revision);
  }

  async isCurrent(
    grant: Pick<HermesProxyGrant, "botId" | "policyRevision">,
  ): Promise<boolean> {
    return (
      validRevision(grant.policyRevision) &&
      this.revisions.get(grant.botId) === grant.policyRevision
    );
  }

  constructor(options: ClockOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  async issue(
    grant: HermesProxyGrantInput,
    ttlMs = HERMES_PROXY_TICKET_TTL_MS,
  ): Promise<IssuedHermesProxyTicket> {
    const issuedAt = this.now();
    const complete = completeGrant(grant, issuedAt, ttlMs);
    await this.publishPolicyRevision(grant.botId, grant.policyRevision);
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
    if (
      !grant ||
      grant.expiresAt <= this.now() ||
      !(await this.isCurrent(grant))
    )
      return null;
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
    this.prefix =
      options.redisKeyPrefix ?? process.env.REDIS_KEY_PREFIX ?? "thechat";
    this.ownsRedis = !options.redis;
    this.redis =
      options.redis ??
      new Redis(
        options.redisUrl ?? process.env.REDIS_URL ?? "redis://localhost:16380",
        {
          lazyConnect: true,
          maxRetriesPerRequest: 1,
          connectTimeout: 1_000,
          commandTimeout: 1_000,
        },
      );
  }

  async issue(
    grant: HermesProxyGrantInput,
    ttlMs = HERMES_PROXY_TICKET_TTL_MS,
  ): Promise<IssuedHermesProxyTicket> {
    const issuedAt = this.now();
    const complete = completeGrant(grant, issuedAt, ttlMs);
    await this.publishPolicyRevision(grant.botId, grant.policyRevision);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const ticket = newTicket();
      const result = await this.redis.eval(
        `if redis.call('GET', KEYS[1]) ~= ARGV[1] then return redis.error_reply('Stale Hermes policy revision') end
         return redis.call('SET', KEYS[2], ARGV[2], 'PX', ARGV[3], 'NX')`,
        2,
        policyKey(grant.botId, this.prefix),
        ticketKey(ticket, this.prefix),
        grant.policyRevision,
        JSON.stringify(complete),
        ttlMs,
      );
      if (result === "OK") {
        return { ticket, expiresAt: complete.expiresAt };
      }
    }
    throw new Error("Could not allocate a unique Hermes proxy ticket");
  }

  async consume(ticket: string): Promise<HermesProxyGrant | null> {
    if (!TICKET_PATTERN.test(ticket)) return null;
    const raw = await this.redis.call("GETDEL", ticketKey(ticket, this.prefix));
    if (typeof raw !== "string") return null;
    const grant = parseGrant(raw);
    if (
      !grant ||
      grant.expiresAt <= this.now() ||
      !(await this.isCurrent(grant))
    )
      return null;
    return grant;
  }

  // Monotonic fencing: an in-flight issuer can never restore an older policy.
  // Keys intentionally have no TTL. Missing keys deny consumption/active tunnels.
  async publishPolicyRevision(botId: string, revision: string): Promise<void> {
    if (!validRevision(revision))
      throw new Error("Invalid Hermes policy revision");
    await this.redis.eval(
      `local current = redis.call('GET', KEYS[1])
       if current and tonumber(current) > tonumber(ARGV[1]) then return redis.error_reply('Stale Hermes policy revision') end
       redis.call('SET', KEYS[1], ARGV[1]); return 1`,
      1,
      policyKey(botId, this.prefix),
      revision,
    );
  }

  async isCurrent(
    grant: Pick<HermesProxyGrant, "botId" | "policyRevision">,
  ): Promise<boolean> {
    return (
      validRevision(grant.policyRevision) &&
      (await this.redis.get(policyKey(grant.botId, this.prefix))) ===
        grant.policyRevision
    );
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
