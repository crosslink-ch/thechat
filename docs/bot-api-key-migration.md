# Bot API-key migration

Bot and machine credentials are owned by Better Auth's API Key plugin. TheChat
keeps the `bots` table as the bot domain entity and continues to enforce bot,
workspace, conversation, and resource authorization after credential
verification.

## Credential flow

```text
bot_ bearer credential
  -> Better Auth API Key verification (`configId = "bot"`)
  -> `referenceId` identifies a `users` row with `type = "bot"`
  -> TheChat loads the matching `bots` row
  -> application authorization runs as before
```

Raw credentials are returned only when a bot is created or its credential is
reissued. PostgreSQL stores the Better Auth hash in `apikey.key`; it does not
store a recoverable bot token. Bot keys remain non-expiring and the plugin's
per-key rate limiter is disabled, preserving the existing machine-client
request contract; owners can rotate or revoke keys explicitly.

## Breaking migration

Migration `0010_better_auth_bot_api_keys.sql` creates the `apikey` table and drops
`bots.api_key`. It intentionally does **not** copy legacy credential values.
There is no new Helm or Infisical value; the API continues to use the existing
Better Auth configuration.

This is a destructive, coordinated upgrade. The chart's migration hook runs
before Kubernetes replaces the old API and worker pods, and those old binaries
still require `bots.api_key`. Take a maintenance window: stop the old API and
worker replicas, apply the migration and new images together, then restart the
workloads. Do not run old and new binaries against the migrated database.

After deployment:

1. Every existing bot credential is invalid.
2. A bot owner must use `POST /bots/:botId/regenerate-key` once per existing bot.
3. The returned key must immediately replace the old credential in Hermes,
   MCP, bot runtimes, and other clients. It cannot be retrieved later.
4. `DELETE /bots/:botId/api-key` disables a credential without deleting the bot;
   the regenerate action reissues and re-enables it.
5. Deleting a bot deletes its Better Auth API-key row through the bot-user
   foreign-key cascade.

There is no dual-read period or legacy fallback.

## Hermes webhook mode

TheChat no longer echoes the bot API token back to a Hermes webhook. When
Hermes registers `POST /bots/me/webhook`, the authenticated response presents
the bot's existing `whsec_` webhook secret. Hermes keeps that secret in memory
and verifies `X-Webhook-Timestamp` plus `X-Webhook-Signature` on deliveries.
Polling mode and Hermes calls back to TheChat continue to use the Better Auth
bot credential as a Bearer token.

Deploy the corresponding Hermes adapter update before or together with this
migration if any bots use webhook delivery. Polling-only Hermes bots do not
need that adapter update.
