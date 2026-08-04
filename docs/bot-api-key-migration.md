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

Polling-only Hermes bots do not need the signed-webhook adapter update. For
webhook bots, use this exact maintenance sequence:

1. Quiesce bot traffic: stop the TheChat bot worker and stop existing Hermes
   TheChat adapters. Scale old TheChat API pods down before the migration so no
   process still queries `bots.api_key` after it is dropped.
2. Stage the upgraded Hermes artifact first, but keep its TheChat adapter
   stopped. The new receiver intentionally does not accept the old Bearer
   webhook contract.
3. Deploy PR #16's Better Auth/Infisical baseline and this change together. Let
   the migration hook complete, then bring up the new TheChat API while the bot
   worker remains stopped.
4. Have each bot owner call `POST /bots/:botId/regenerate-key`. Put that one-time
   raw `bot_...` result into the bot's Hermes configuration; never write it to
   Helm values or logs.
5. Start the upgraded Hermes adapter. Its authenticated `POST /bots/me/webhook`
   registration stores the URL and returns the current `whsec_...` secret to
   Hermes.
6. Confirm Hermes registered successfully, then start the new TheChat bot worker
   and resume bot traffic. Deliveries now use timestamped HMAC signatures and
   are deduplicated by `invocationId` at the receiver.

Do not run the signed TheChat sender against an old Hermes receiver, and do not
start the new Hermes adapter against an old TheChat API. Neither side has a
legacy fallback.

## Rollback limitations

Migration `0010_better_auth_bot_api_keys.sql` is destructive. Rolling only TheChat
back after it runs is unsafe because old application code requires
`bots.api_key`, and the dropped plaintext values cannot be reconstructed.
Rolling only Hermes back is also unsafe because new TheChat no longer sends bot
Bearer credentials on webhook requests.

Prefer roll-forward. A true rollback requires stopping bot traffic again,
rolling back both applications, restoring a pre-migration database backup
(including the old plaintext keys), and then restarting the old pair. If that
backup is unavailable, keep the new schema and recover by fixing forward and
explicitly reissuing affected bot credentials.
