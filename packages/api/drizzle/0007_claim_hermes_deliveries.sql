-- Hermes invocation rows track delivery ownership, not the lifetime of the
-- external Hermes run. Polling rows were already handed to Hermes when they
-- became `running`; old webhook rows have likewise outlived the existing
-- ten-minute delivery retry guard and must not remain durable liveness signals.
UPDATE "bot_invocations"
SET
  "status" = 'claimed',
  "completed_at" = COALESCE("completed_at", "started_at", "updated_at", now()),
  "updated_at" = now()
WHERE
  "adapter_kind" = 'hermes'
  AND "status" = 'running'
  AND (
    "request_json"->>'deliveryMode' = 'polling'
    OR COALESCE("started_at", "updated_at", "created_at") < now() - INTERVAL '10 minutes'
  );
