// Non-secret policy lives in source like the pg-boss queue configuration.
// All API replicas must run the same policy. Counters are stored in PostgreSQL.
export const incomingWebhookConfig = Object.freeze({
  maxBodyBytes: 65_536,
  rateLimitMax: 30,
  rateLimitWindowMs: 60_000,
});
