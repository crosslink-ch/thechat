# Corrected TheChat Hermes bot integration plan

Status: corrected after architecture review on 2026-05-06.

## Direction

TheChat is a frontend/control UI for Hermes Gateway/API. Hermes Gateway is the canonical owner of runtime state:

- Hermes sessions
- Hermes runs and run events
- Hermes jobs/cron state
- runtime health/capabilities

TheChat should not duplicate canonical Hermes state in its own Postgres database. Do not add `hermes_sessions`, `hermes_runs`, or `hermes_run_events` tables unless a future feature explicitly requires a bounded cache or a tiny correlation record.

## TheChat-owned state

TheChat owns only product/chat concerns:

- workspace, channel, membership, message UX
- normal bot user identity for mentions/avatar/channel membership
- Hermes bot configuration and secret boundary

The only Hermes-specific table in the MVP is `hermes_bot_configs`, keyed by TheChat `bot_id`, with Hermes base URL, encrypted API key, default instructions, and default session scope.

## API shape

Use normal bot creation for the chat participant only. Connecting an existing Hermes runtime is a separate control-plane step on that bot.

```text
POST   /bots/create                    # creates bot participant; accepts kind: "webhook" | "hermes"
GET    /bots/:botId/hermes             # connection/defaults, without secret material
PATCH  /bots/:botId/hermes             # connect/update existing Hermes base URL, API key, defaults
POST   /bots/:botId/hermes/test        # health + capabilities through backend
GET    /bots/:botId/hermes/capabilities
```

Do not put Hermes connection secrets in `POST /bots/create`, and do not add `POST /hermes/bots/create`.
Do not add local `/hermes/runs` list/detail/event endpoints backed by TheChat tables. Browsing historical sessions/runs/jobs should proxy/query Hermes Gateway directly when that UI is built.

## Mention flow

1. User sends a channel message mentioning a Hermes bot.
2. TheChat resolves bot membership and branches by `bots.kind`.
3. Webhook bots keep the signed webhook flow.
4. Hermes bots call Hermes Gateway `POST /v1/runs` through TheChat backend using a stable `session_id` such as:

```text
thechat:workspace:<workspaceId>:conversation:<conversationId>:bot:<botId>
```

5. TheChat streams the active run only to derive the final response for chat UX.
6. TheChat inserts the final bot-authored message into the channel.
7. TheChat does not persist a `hermes_runs` row or run events; Hermes Gateway remains the source of truth.

## Deferred UI

When adding session/run/job browsers, build them as Gateway-backed control-plane views. If TheChat needs linking, prefer a minimal correlation record like `message_id -> hermes_run_id`, not a duplicate run ledger.
