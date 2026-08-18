import { sql } from "drizzle-orm";
import { db } from "../db";
import { API_KEY_HASHER } from "./better-auth";

type StoredApiKeyState = {
  id: string;
  enabled: boolean;
  expiresAt: Date | null;
};

/**
 * Better Auth 1.6.20 maps unexpected adapter failures to INVALID_API_KEY.
 * Re-read the exact hashed credential before accepting that classification:
 * an active stored row means verification failed after lookup and must remain
 * a retryable infrastructure error rather than becoming a false 401.
 */
export async function surfaceStoredApiKeyVerificationFailure(
  rawKey: string,
  configId: string,
): Promise<void> {
  const hashedKey = await API_KEY_HASHER(rawKey);
  const [stored] = await db.execute<StoredApiKeyState>(sql`
    select
      "id",
      "enabled",
      "expires_at" as "expiresAt"
    from "apikey"
    where "config_id" = ${configId}
      and "key" = ${hashedKey}
    limit 1
  `);

  if (!stored || !stored.enabled) return;
  if (stored.expiresAt && stored.expiresAt.getTime() <= Date.now()) return;

  throw new Error("API key verification failed for a stored active credential");
}
