import crypto from "crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { apikey } from "../db/schema";
import {
  auth,
  BOT_API_KEY_CONFIG_ID,
  BOT_API_KEY_HASHER,
  BOT_API_KEY_PREFIX,
  generateBotApiKey,
} from "./better-auth";
import { surfaceStoredApiKeyVerificationFailure } from "./api-key-verification";

const STORED_START_LENGTH = 6;
const BOT_API_KEY_ROTATION_COOLDOWN_MS = 5_000;

export class BotApiKeyRotationConflictError extends Error {
  constructor() {
    super("Bot API key changed concurrently");
    this.name = "BotApiKeyRotationConflictError";
  }
}

export interface PreparedBotApiKey {
  rawKey: string;
  values: typeof apikey.$inferInsert;
}

function parseApiKeyMetadata(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export async function prepareBotApiKey(referenceId: string): Promise<PreparedBotApiKey> {
  const rawKey = generateBotApiKey();
  const now = new Date();
  return {
    rawKey,
    values: {
      id: crypto.randomUUID(),
      configId: BOT_API_KEY_CONFIG_ID,
      key: await BOT_API_KEY_HASHER(rawKey),
      referenceId,
      start: rawKey.slice(0, STORED_START_LENGTH),
      prefix: BOT_API_KEY_PREFIX,
      enabled: true,
      refillInterval: null,
      refillAmount: null,
      lastRefillAt: null,
      rateLimitEnabled: false,
      rateLimitTimeWindow: null,
      rateLimitMax: null,
      requestCount: 0,
      remaining: null,
      lastRequest: null,
      expiresAt: null,
      createdAt: now,
      updatedAt: now,
    },
  };
}

export async function createBotApiKey(referenceId: string): Promise<string> {
  const prepared = await prepareBotApiKey(referenceId);
  await db.insert(apikey).values(prepared.values);
  return prepared.rawKey;
}

export async function verifyBotApiKey(rawKey: string): Promise<string | null> {
  const result = await auth.api.verifyApiKey({
    body: {
      configId: BOT_API_KEY_CONFIG_ID,
      key: rawKey,
    },
  });

  if (!result.valid || !result.key) {
    if (result.error?.code === "INVALID_API_KEY") {
      await surfaceStoredApiKeyVerificationFailure(
        rawKey,
        BOT_API_KEY_CONFIG_ID,
      );
    }
    return null;
  }

  return result.key.referenceId;
}

export async function rotateBotApiKey(referenceId: string): Promise<string> {
  const prepared = await prepareBotApiKey(referenceId);
  return db.transaction(async (tx) => {
    const lockKey = `bot-api-key:${referenceId}`;
    const [lock] = await tx.execute<{ acquired: boolean }>(
      sql`select pg_try_advisory_xact_lock(hashtextextended(${lockKey}, 0)) as acquired`,
    );
    if (!lock?.acquired) throw new BotApiKeyRotationConflictError();

    const [existing] = await tx
      .select({ id: apikey.id, key: apikey.key, metadata: apikey.metadata })
      .from(apikey)
      .where(
        and(
          eq(apikey.configId, BOT_API_KEY_CONFIG_ID),
          eq(apikey.referenceId, referenceId),
        ),
      )
      .limit(1);

    if (!existing) {
      const [inserted] = await tx
        .insert(apikey)
        .values({
          ...prepared.values,
          metadata: JSON.stringify({ lastRotatedAt: Date.now(), rotationVersion: 1 }),
        })
        .onConflictDoNothing()
        .returning({ id: apikey.id });
      if (!inserted) throw new BotApiKeyRotationConflictError();
      return prepared.rawKey;
    }

    const metadata = parseApiKeyMetadata(existing.metadata);
    const lastRotatedAt = metadata.lastRotatedAt;
    const now = Date.now();
    if (
      typeof lastRotatedAt === "number" &&
      now - lastRotatedAt < BOT_API_KEY_ROTATION_COOLDOWN_MS
    ) {
      throw new BotApiKeyRotationConflictError();
    }
    const rotationVersion =
      typeof metadata.rotationVersion === "number" ? metadata.rotationVersion + 1 : 1;

    const [updated] = await tx
      .update(apikey)
      .set({
        key: prepared.values.key,
        start: prepared.values.start,
        prefix: prepared.values.prefix,
        enabled: true,
        refillInterval: null,
        refillAmount: null,
        lastRefillAt: null,
        rateLimitEnabled: false,
        rateLimitTimeWindow: null,
        rateLimitMax: null,
        requestCount: 0,
        remaining: null,
        lastRequest: null,
        expiresAt: null,
        metadata: JSON.stringify({
          ...metadata,
          lastRotatedAt: now,
          rotationVersion,
        }),
        updatedAt: prepared.values.updatedAt,
      })
      .where(and(eq(apikey.id, existing.id), eq(apikey.key, existing.key)))
      .returning({ id: apikey.id });

    if (!updated) throw new BotApiKeyRotationConflictError();
    return prepared.rawKey;
  });
}

export async function revokeBotApiKey(referenceId: string): Promise<void> {
  await db
    .update(apikey)
    .set({ enabled: false, updatedAt: new Date() })
    .where(
      and(
        eq(apikey.configId, BOT_API_KEY_CONFIG_ID),
        eq(apikey.referenceId, referenceId),
      ),
    );
}
