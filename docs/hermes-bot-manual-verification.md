# Hermes bot manual verification

This guide verifies the native TheChat <-> Hermes Gateway platform adapter.
TheChat does not call Hermes `/v1/runs` directly; it exposes pending bot
invocations at `/hermes-platform/*`. Hermes Gateway can consume those
invocations either by polling `/hermes-platform/events` or by receiving pushes
at a webhook URL configured on the bot record.

## Ports used

- TheChat API for manual testing: `3337`
- Optional Hermes TheChat webhook for manual testing: `8765`
- Compose Postgres: `15543 -> 5432`
- Automated Hermes e2e defaults: API `3338`, Postgres `15544`, Redis `16381`

## 1. Start TheChat dependencies

```bash
cd /home/bruno/agent-worktrees/thechat-hermes-integration
```

Create a local `.env` if you do not already have one:

```bash
cat > .env <<'EOF'
DATABASE_URL=postgres://thechat:thechat@localhost:15543/thechat
REDIS_URL=redis://localhost:16380
JWT_SECRET=change-me-local-thechat-jwt-secret
THECHAT_SECRET_KEY=change-me-local-thechat-secret-key
THECHAT_BACKEND_PORT=3337
OPENROUTER_API_KEY=...
LOG_LEVEL=info
EOF
```

Start services and apply migrations:

```bash
docker compose up -d postgres redis
PATH="$HOME/.bun/bin:$PATH" pnpm --filter @thechat/api db:migrate
```

## 2. Start TheChat

API and bot worker:

```bash
PATH="$HOME/.bun/bin:$PATH" pnpm dev:services
```

Or start them in separate terminals:

```bash
PATH="$HOME/.bun/bin:$PATH" pnpm dev:api
PATH="$HOME/.bun/bin:$PATH" pnpm dev:worker
```

In another terminal, start desktop if you want to verify through UI:

```bash
PATH="$HOME/.bun/bin:$PATH" pnpm dev:desktop
```

## 3. Add a Hermes bot and copy its token

Open TheChat desktop, create or select a workspace, open the command palette,
and run **Add Hermes Bot**.

Use any bot name, for example `Koda`, and optional instructions such as
`Reply concisely in TheChat.` After creation, TheChat shows a `.env` snippet
containing a `THECHAT_BOT_TOKEN=bot_...` value. Add those variables to the
environment file loaded by Hermes Gateway.

Each Hermes bot has its own token. To run two Hermes bots, create two bots and
start one Hermes Gateway process per token, each with its own `HERMES_HOME`.

## 4. Start Hermes Gateway with TheChat platform

Shortcut if you already have the `bot_...` token from TheChat:

```bash
cd /home/bruno/agent-worktrees/thechat-hermes-integration
PATH="$HOME/.bun/bin:$PATH" pnpm dev:hermes -- bot_...
```

This starts Compose Postgres/Redis, runs API migrations, starts TheChat API and
the bot worker, validates the bot token, and starts Hermes Gateway with an
isolated `HERMES_HOME`. Add `--desktop` to also start the web dev UI at
`http://localhost:1420`, or `--tauri` to launch the Tauri app. If TheChat API
is already running at the target URL, the script reuses it and still starts a
local bot worker unless `--no-worker` is set.

The expanded manual steps are below.

Use the Hermes checkout that contains the TheChat adapter:

```bash
cd /home/bruno/projects/hermes2
uv sync --frozen
```

Use an isolated Hermes home so local `~/.hermes` state is not touched:

```bash
export HERMES_HOME=/home/bruno/agent-worktrees/thechat-hermes-integration/.tmp/hermes-thechat-manual
mkdir -p "$HERMES_HOME"

cat > "$HERMES_HOME/config.yaml" <<'EOF'
model:
  provider: openrouter
  default: deepseek/deepseek-v4-pro
streaming:
  enabled: false
EOF
```

Add the TheChat platform settings to the `.env` file loaded by Hermes Gateway,
replacing `bot_...` with the bot token shown by TheChat. Choose one delivery
mode: polling claims queued invocations from TheChat, while webhook mode lets
TheChat push invocations to a reachable Hermes Gateway callback URL.

```dotenv
THECHAT_BASE_URL=http://localhost:3337
THECHAT_BOT_TOKEN=bot_...
THECHAT_ALLOW_ALL_USERS=true

# Polling mode:
THECHAT_POLL_INTERVAL=1.0

# Webhook mode:
# THECHAT_WEBHOOK_URL=http://localhost:8765/thechat/webhook
```

Run the gateway. Use the runtime wrapper below instead of `hermes gateway run`
when `HERMES_HOME` is pointing at a temporary test/manual directory; the CLI
command may refresh an installed user service definition, while this wrapper
starts the gateway runtime in the foreground only.

```bash
set -a
. /home/bruno/agent-worktrees/thechat-hermes-integration/.env
set +a

uv run --frozen python -u /home/bruno/agent-worktrees/thechat-hermes-integration/scripts/e2e/run-hermes-gateway-runtime.py
```

In webhook mode, Hermes registers `THECHAT_WEBHOOK_URL` through the generic bot
webhook endpoint `POST /bots/me/webhook`.

Health check TheChat's platform bridge:

```bash
curl -H "Authorization: Bearer bot_..." \
  http://localhost:3337/hermes-platform/health
```

## 5. Manual UI flow

1. Open the workspace's default channel.
2. Send `@Koda say hello from TheChat`.
3. Open a direct message with `Koda` and send `say hello from DM`.

Expected result in polling mode:

- Hermes Gateway claims queued invocations through `/hermes-platform/events`.
- The final response is posted back through `/hermes-platform/messages`.
- The bot responds in channels when mentioned and in direct messages without a mention.
- The bot runtime panel shows session/activity state for the Hermes bot.

Expected result in webhook mode:

- The API enqueues a Hermes webhook delivery job in Redis.
- The separate bot worker consumes that job and posts the invocation to the
  Hermes Gateway webhook URL.
- Hermes Gateway posts the final response back through `/hermes-platform/messages`.

## 6. Simulate Hermes without Gateway or LLM

Use `scripts/hermes-progress-demo.mjs` when you want to test the TheChat UI and
Hermes task-thread plumbing without running Hermes Gateway or calling a model.
It acts like a tiny fake Hermes Gateway: it claims pending `/hermes-platform`
invocations, emits progress events, posts responses, and can also send
cron-style proactive messages.

Start TheChat API/worker/desktop as usual, create a Hermes bot, copy its
`bot_...` token, and leave the real Hermes Gateway stopped.

To test two parallel task threads from the UI:

```bash
cd /home/bruno/agent-worktrees/thechat-hermes-integration
THECHAT_BOT_TOKEN=bot_... pnpm dev:hermes-progress-demo -- \
  --scenario=parallel \
  --count=2 \
  --cron
```

Then open the Hermes DM in the desktop UI, create two tasks, and send one
message in each task. The simulator claims both invocations, interleaves
progress across them, completes both, and posts a cron-style message back into
each same task thread.

To test failure, cancellation, and a still-running invocation:

```bash
THECHAT_BOT_TOKEN=bot_... pnpm dev:hermes-progress-demo -- \
  --scenario=parallel \
  --count=3 \
  --outcomes=fail,cancel,running
```

To post only a cron/proactive message after copying IDs from the script output
or API responses:

```bash
THECHAT_BOT_TOKEN=bot_... pnpm dev:hermes-progress-demo -- \
  --scenario=cron \
  --chat-id=<conversation-id> \
  --thread-id=<task-thread-id> \
  --cron-content='Scheduled update for task {index}'
```

Useful flags:

- `--outcomes=complete,fail,cancel,running,message-only` controls each claimed
  invocation.
- `--hold-ms=400` speeds up progress stages.
- `--no-complete` leaves claimed invocations running by default.
- `--help` prints the full option list.

## 7. API-only manual flow

These commands exercise the same flow without the desktop UI.

```bash
API=http://localhost:3337
EMAIL="hermes-manual-$(date +%s)@example.com"

TOKEN=$(curl -sS -X POST "$API/auth/register" \
  -H 'Content-Type: application/json' \
  -d "{\"name\":\"Hermes Manual\",\"email\":\"$EMAIL\",\"password\":\"password123\"}" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["accessToken"])')

WORKSPACE_ID=$(curl -sS -X POST "$API/workspaces/create" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Hermes Manual Workspace"}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')

BOT_JSON=$(curl -sS -X POST "$API/bots/create" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"kind\":\"hermes\",\"workspaceId\":\"$WORKSPACE_ID\",\"name\":\"Koda\"}")

BOT_ID=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["id"])' "$BOT_JSON")
THECHAT_BOT_TOKEN=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["apiKey"])' "$BOT_JSON")

curl -sS -X PATCH "$API/bots/$BOT_ID/hermes" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"defaultInstructions":"Reply concisely in TheChat."}'

CHANNEL_ID=$(curl -sS "$API/workspaces/$WORKSPACE_ID" \
  -H "Authorization: Bearer $TOKEN" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["channels"][0]["id"])')
```

Start Hermes with the API-created bot token before sending the message. Put the
same TheChat platform settings in the `.env` file loaded by Hermes Gateway:

```dotenv
THECHAT_BASE_URL=http://localhost:3337
THECHAT_BOT_TOKEN=bot_...
THECHAT_ALLOW_ALL_USERS=true

# Polling mode:
THECHAT_POLL_INTERVAL=1.0

# Webhook mode:
# THECHAT_WEBHOOK_URL=http://localhost:8765/thechat/webhook
```

Then run the gateway:

```bash
cd /home/bruno/projects/hermes2

set -a
. /home/bruno/agent-worktrees/thechat-hermes-integration/.env
set +a

uv run --frozen python -u /home/bruno/agent-worktrees/thechat-hermes-integration/scripts/e2e/run-hermes-gateway-runtime.py
```

Then send a message in another terminal:

```bash
curl -sS -X POST "$API/messages/$CHANNEL_ID" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"content":"@Koda say hello from the API-only manual test"}'

sleep 10
curl -sS "$API/messages/$CHANNEL_ID" -H "Authorization: Bearer $TOKEN"
```

## 8. Automated E2E smoke

The Hermes suite is opt-in and is wired into the main test runner:

```bash
PATH="$HOME/.bun/bin:$PATH" python3 scripts/test.py hermes
```

You can also run the script directly:

```bash
PATH="$HOME/.bun/bin:$PATH" python3 scripts/e2e/hermes-bot-flow.py
```

The E2E script starts isolated Postgres and Redis containers, starts TheChat
API, creates multiple named Hermes bots, starts one Hermes Gateway process per
bot token from `/home/bruno/projects/hermes2`, verifies channel mentions and
direct-message responses, checks session continuity, and cleans up unless
`HERMES_E2E_KEEP=1` is set.
