# Hermes bot manual verification

This guide verifies the native TheChat <-> Hermes Gateway platform adapter.
TheChat does not call Hermes `/v1/runs` directly; it exposes pending bot
invocations at `/hermes-platform/*`, and Hermes polls those endpoints as a
messaging platform.

## Ports used

- TheChat API for manual testing: `3337`
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

API only:

```bash
PATH="$HOME/.bun/bin:$PATH" pnpm dev:api
```

In another terminal, start desktop if you want to verify through UI:

```bash
PATH="$HOME/.bun/bin:$PATH" pnpm dev:desktop
```

## 3. Add a Hermes bot and copy its token

Open TheChat desktop, create or select a workspace, open the command palette,
and run **Add Hermes Bot**.

Use any bot name, for example `Koda`, and optional instructions such as
`Reply concisely in TheChat.` After creation, TheChat shows a setup command
containing a `THECHAT_BOT_TOKEN=bot_...` value. Keep that token for the next
step.

Each Hermes bot has its own token. To run two Hermes bots, create two bots and
start one Hermes Gateway process per token, each with its own `HERMES_HOME`.

## 4. Start Hermes Gateway with TheChat platform

Use the Hermes checkout that contains the TheChat adapter:

```bash
cd /home/bruno/projects/hermes2
uv sync --frozen
```

Use an isolated Hermes home so local `~/.hermes` state is not touched:

```bash
export HERMES_HOME=/tmp/hermes-thechat-manual
mkdir -p "$HERMES_HOME"

cat > "$HERMES_HOME/config.yaml" <<'EOF'
model:
  provider: openrouter
  default: deepseek/deepseek-v4-pro
streaming:
  enabled: false
EOF
```

Run the gateway, replacing `bot_...` with the bot token shown by TheChat:

```bash
set -a
. /home/bruno/agent-worktrees/thechat-hermes-integration/.env
set +a

THECHAT_BASE_URL=http://localhost:3337 \
THECHAT_BOT_TOKEN=bot_... \
THECHAT_ALLOW_ALL_USERS=true \
THECHAT_POLL_INTERVAL=0.5 \
uv run --frozen hermes gateway run --replace
```

Health check TheChat's platform bridge:

```bash
curl -H "Authorization: Bearer bot_..." \
  http://localhost:3337/hermes-platform/health
```

## 5. Manual UI flow

1. Open the workspace's default channel.
2. Send `@Koda say hello from TheChat`.
3. Open a direct message with `Koda` and send `say hello from DM`.

Expected result:

- Hermes Gateway claims queued TheChat invocations through `/hermes-platform/events`.
- The final response is posted back through `/hermes-platform/messages`.
- The bot responds in channels when mentioned and in direct messages without a mention.
- The bot runtime panel shows session/activity state for the Hermes bot.

## 6. API-only manual flow

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
  -d '{"defaultInstructions":"Reply concisely."}'

CHANNEL_ID=$(curl -sS "$API/workspaces/$WORKSPACE_ID" \
  -H "Authorization: Bearer $TOKEN" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["channels"][0]["id"])')
```

Start Hermes with the API-created bot token before sending the message:

```bash
cd /home/bruno/projects/hermes2

THECHAT_BASE_URL=http://localhost:3337 \
THECHAT_BOT_TOKEN="$THECHAT_BOT_TOKEN" \
THECHAT_ALLOW_ALL_USERS=true \
THECHAT_POLL_INTERVAL=0.5 \
uv run --frozen hermes gateway run --replace
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

## 7. Automated E2E smoke

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
