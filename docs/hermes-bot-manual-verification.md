# Hermes bot manual verification

This guide verifies the native TheChat ↔ Hermes Agent integration. It assumes the feature branch/worktree is checked out at `/home/bruno/agent-worktrees/thechat-hermes-integration`.

## Ports used

- TheChat API for manual testing: `3337`
- TheChat desktop dev/Vite: keep the repo default unless you override it
- Compose Postgres: `15543 -> 5432`
- Manual Hermes API server: `18642 -> 8642`
- Manual Hermes dashboard: `19119 -> 9119`
- Automated Hermes e2e defaults: API `3338`, Postgres `15544`, Hermes API `18643`, dashboard `19120`

## 1. Start Postgres for TheChat

```bash
cd /home/bruno/agent-worktrees/thechat-hermes-integration

Create a local `.env` (ignored by git):

```bash
cat > .env <<'EOF'
DATABASE_URL=postgres://thechat:thechat@localhost:15543/thechat
JWT_SECRET=change-me-local-thechat-jwt-secret
THECHAT_SECRET_KEY=change-me-local-thechat-secret-key
THECHAT_BACKEND_PORT=3337
LOG_LEVEL=info
EOF
```

Start Postgres and apply migrations:

```bash
docker compose up -d postgres
PATH="$HOME/.bun/bin:$PATH" pnpm --filter @thechat/api db:migrate
```

## 2. Start Hermes Agent in Docker

`scripts/start-hermes-docker.sh` reads `OPENROUTER_API_KEY` from the repo root `.env`, configures Hermes for `openrouter` / `deepseek/deepseek-v4-pro` by default, and prints the base URL/API key to use in TheChat. TheChat stores the Hermes API key encrypted and never returns it from the API.

```bash
export HERMES_API_KEY="${HERMES_API_KEY:-change-me-local-hermes-key}"
./scripts/start-hermes-docker.sh
```

Health check:

```bash
curl -H "Authorization: Bearer $HERMES_API_KEY" http://localhost:18642/health
curl -H "Authorization: Bearer $HERMES_API_KEY" http://localhost:18642/v1/capabilities
```

If real Hermes runs fail, configure the Hermes container with a provider/model first (for example by mounting an existing Hermes data dir or forwarding provider API keys). The TheChat integration itself only requires the API server base URL and bearer key.

## 3. Start TheChat

API only:

```bash
PATH="$HOME/.bun/bin:$PATH" pnpm dev:api
```

In another terminal, start desktop if you want to verify through UI:

```bash
PATH="$HOME/.bun/bin:$PATH" pnpm dev:desktop
```

## 4. Manual UI flow

1. Open TheChat desktop.
2. Register or log in.
3. Create a workspace, e.g. `Hermes Manual Test`.
4. Open the command palette and run **Add Hermes Bot**.
   - Name: `Koda` or any bot name you want
   - Base URL: `http://localhost:18642`
   - API key: value of `$HERMES_API_KEY`
   - Optional instructions: `Reply concisely in TheChat.`
5. Open the workspace's default channel.
6. Send a message mentioning the bot, for example:
   - `@Koda say hello from TheChat`
7. Expected result:
   - Hermes Gateway owns the canonical run/session state; TheChat only posts the final bot message into the channel.
   - Hermes receives `POST /v1/runs` and `GET /v1/runs/{id}/events`.
   - A final bot-authored message appears in the channel.
   - API responses never include the Hermes API key.

## 5. API-only manual flow

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

BOT_ID=$(curl -sS -X POST "$API/bots/create" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"kind\":\"hermes\",\"workspaceId\":\"$WORKSPACE_ID\",\"name\":\"Koda\"}" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')

curl -sS -X PATCH "$API/bots/$BOT_ID/hermes" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"baseUrl\":\"http://localhost:18642\",\"apiKey\":\"$HERMES_API_KEY\",\"defaultInstructions\":\"Reply concisely.\"}"

curl -sS -X POST "$API/bots/$BOT_ID/hermes/test" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{}'

CHANNEL_ID=$(curl -sS "$API/workspaces/$WORKSPACE_ID" \
  -H "Authorization: Bearer $TOKEN" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["channels"][0]["id"])')

curl -sS -X POST "$API/messages/$CHANNEL_ID" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"content":"@Koda say hello from the API-only manual test"}'

sleep 5
curl -sS "$API/messages/$CHANNEL_ID" -H "Authorization: Bearer $TOKEN"
# There is intentionally no TheChat /hermes/runs endpoint; inspect canonical run/session state in Hermes Gateway/API.
```

## 6. Automated E2E smoke

Real Hermes Agent Docker image:

```bash
PATH="$HOME/.bun/bin:$PATH" HERMES_E2E_API_KEY="$HERMES_API_KEY" pnpm test:e2e:hermes
PATH="$HOME/.bun/bin:$PATH" HERMES_E2E_API_KEY="$HERMES_API_KEY" python3 scripts/test.py hermes
```

The E2E script starts its own isolated Postgres and Hermes containers, starts TheChat API, creates a user/workspace, adds multiple named Hermes bots, verifies channel mentions and a direct-message reply, and cleans up containers unless `HERMES_E2E_KEEP=1` is set. Override ports with `THECHAT_E2E_API_PORT`, `THECHAT_E2E_POSTGRES_PORT`, `THECHAT_E2E_HERMES_PORT`, and `THECHAT_E2E_HERMES_DASHBOARD_PORT`.
