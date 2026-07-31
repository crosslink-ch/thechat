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

const STORED_START_LENGTH = 6;

export async function createBotApiKey(referenceId: string): Promise<string> {
  const created = await auth.api.createApiKey({
    body: {
      configId: BOT_API_KEY_CONFIG_ID,
      userId: referenceId,
      expiresIn: null,
      remaining: null,
      rateLimitEnabled: false,
    },
  });

  return created.key;
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
      // Better Auth 1.6.20 maps both an unknown key and unexpected adapter
      // failures to INVALID_API_KEY. Probe the same store before classifying
      // that result as ordinary bad credentials so outages propagate as 503.
      await db.execute(sql`select id from "apikey" limit 1`);
    }
    return null;
  }

  return result.key.referenceId;
}

export async function rotateBotApiKey(referenceId: string): Promise<string> {
  const rawKey = generateBotApiKey();
  const hashedKey = await BOT_API_KEY_HASHER(rawKey);
  const now = new Date();

  const [updated] = await db
    .update(apikey)
    .set({
      key: hashedKey,
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
      updatedAt: now,
    })
    .where(
      and(
        eq(apikey.configId, BOT_API_KEY_CONFIG_ID),
        eq(apikey.referenceId, referenceId),
      ),
    )
    .returning({ id: apikey.id });

  // Bots created before this migration intentionally have no migrated
  // credential. Their first reissue creates a new Better Auth API-key row.
  if (!updated) return createBotApiKey(referenceId);

  return rawKey;
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
