CREATE INDEX "bot_invocations_terminal_retention_idx" ON "bot_invocations" USING btree ("updated_at", "id") WHERE
  "bot_invocations"."completed_at" IS NOT NULL
  AND (
    "bot_invocations"."status" IN ('completed', 'failed', 'cancelled')
    OR (
      "bot_invocations"."status" = 'claimed'
      AND (
        NULLIF("bot_invocations"."response_json"->'completion'->>'type', '') IS NOT NULL
        OR COALESCE("bot_invocations"."response_json"->>'silent', 'false') = 'true'
      )
    )
  );
