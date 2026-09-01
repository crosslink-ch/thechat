import { sql } from "drizzle-orm";
import { db } from "../db";

/**
 * Delete one bounded batch of terminal invocation metadata. Hermes delivery
 * also writes `completed_at`, so a `claimed` row is eligible only when it has
 * an explicit execution-completion marker in `response_json`. Retention ages
 * from `updated_at`, which the terminal callback refreshes.
 */
export async function pruneTerminalBotInvocations(options: {
  before: Date;
  batchSize: number;
}): Promise<number> {
  const batchSize = Math.max(1, Math.min(options.batchSize, 5_000));
  const rows = await db.execute<{ id: string }>(sql`
    WITH candidates AS (
      SELECT id
      FROM bot_invocations
      WHERE completed_at IS NOT NULL
        AND updated_at < ${options.before.toISOString()}::timestamptz
        AND (
          status IN ('completed', 'failed', 'cancelled')
          OR (
            status = 'claimed'
            AND (
              NULLIF(response_json->'completion'->>'type', '') IS NOT NULL
              OR COALESCE(response_json->>'silent', 'false') = 'true'
            )
          )
        )
      ORDER BY updated_at, id
      FOR UPDATE SKIP LOCKED
      LIMIT ${batchSize}
    )
    DELETE FROM bot_invocations AS invocation
    USING candidates
    WHERE invocation.id = candidates.id
    RETURNING invocation.id
  `);
  return Array.from(rows).length;
}
