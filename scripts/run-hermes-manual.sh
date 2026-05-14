#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
  cat <<'EOF'
Usage:
  scripts/run-hermes-manual.sh bot_...
  scripts/run-hermes-manual.sh --bot-token bot_... [options]

Starts local TheChat dependencies, TheChat API, the bot worker, and an isolated
Hermes Gateway for manual Hermes bot testing. Press Ctrl-C to stop the started
processes.

Options:
  --bot-token TOKEN          TheChat Hermes bot API key, usually bot_...
  --base-url URL            TheChat API base URL (default: http://localhost:3337)
  --api-port PORT           TheChat API port when --base-url is not set (default: 3337)
  --hermes-source-dir DIR   Hermes checkout with TheChat adapter (default: /home/bruno/projects/hermes2)
  --hermes-home DIR         Isolated Hermes home (default: .tmp/hermes-thechat-manual)
  --provider NAME           Hermes provider (default: HERMES_PROVIDER or openrouter)
  --model NAME              Hermes model (default: HERMES_MODEL or deepseek/deepseek-v4-pro)
  --desktop                 Also start the Vite desktop UI dev server
  --tauri                   Also start the Tauri desktop app
  --no-worker               Do not start the local TheChat bot worker
  --no-deps                 Do not start Compose Postgres/Redis
  --no-migrate              Do not run API migrations
  --no-hermes-sync          Do not run uv sync --frozen in the Hermes checkout
  --stop-deps-on-exit       Stop Compose Postgres/Redis when this script exits
  -h, --help                Show this help

Environment overrides:
  THECHAT_BOT_TOKEN, THECHAT_BACKEND_PORT, THECHAT_BACKEND_URL,
  THECHAT_POLL_INTERVAL,
  THECHAT_WEBHOOK_HOST, THECHAT_WEBHOOK_PORT, THECHAT_WEBHOOK_PATH,
  THECHAT_WEBHOOK_URL,
  HERMES_E2E_SOURCE_DIR, THECHAT_HERMES_HOME, HERMES_PROVIDER, HERMES_MODEL,
  OPENROUTER_API_KEY, PNPM, BUN, UV
EOF
}

log() {
  printf '\033[1;34m%s\033[0m %s\n' "==>" "$*"
}

warn() {
  printf '\033[1;33m%s\033[0m %s\n' "WARN" "$*" >&2
}

fail() {
  printf '\033[1;31m%s\033[0m %s\n' "ERROR" "$*" >&2
  exit 1
}

if [[ -f "$ROOT/.env" ]]; then
  set -a
  # shellcheck source=/dev/null
  . "$ROOT/.env"
  set +a
fi

BOT_TOKEN="${THECHAT_BOT_TOKEN:-}"
API_PORT="${THECHAT_BACKEND_PORT:-3337}"
API_PORT_SET=0
BASE_URL="${THECHAT_BACKEND_URL:-}"
HERMES_SOURCE_DIR="${HERMES_E2E_SOURCE_DIR:-/home/bruno/projects/hermes2}"
HERMES_MANUAL_HOME="${THECHAT_HERMES_HOME:-$ROOT/.tmp/hermes-thechat-manual}"
HERMES_PROVIDER_VALUE="${HERMES_PROVIDER:-openrouter}"
HERMES_MODEL_VALUE="${HERMES_MODEL:-deepseek/deepseek-v4-pro}"
START_DEPS=1
RUN_MIGRATIONS=1
RUN_HERMES_SYNC=1
STOP_DEPS_ON_EXIT=0
START_WORKER=1
DESKTOP_MODE="none"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --bot-token)
      [[ $# -ge 2 ]] || fail "--bot-token requires a value"
      BOT_TOKEN="$2"
      shift 2
      ;;
    --base-url)
      [[ $# -ge 2 ]] || fail "--base-url requires a value"
      BASE_URL="$2"
      shift 2
      ;;
    --api-port)
      [[ $# -ge 2 ]] || fail "--api-port requires a value"
      API_PORT="$2"
      API_PORT_SET=1
      shift 2
      ;;
    --hermes-source-dir)
      [[ $# -ge 2 ]] || fail "--hermes-source-dir requires a value"
      HERMES_SOURCE_DIR="$2"
      shift 2
      ;;
    --hermes-home)
      [[ $# -ge 2 ]] || fail "--hermes-home requires a value"
      HERMES_MANUAL_HOME="$2"
      shift 2
      ;;
    --provider)
      [[ $# -ge 2 ]] || fail "--provider requires a value"
      HERMES_PROVIDER_VALUE="$2"
      shift 2
      ;;
    --model)
      [[ $# -ge 2 ]] || fail "--model requires a value"
      HERMES_MODEL_VALUE="$2"
      shift 2
      ;;
    --desktop)
      DESKTOP_MODE="web"
      shift
      ;;
    --tauri)
      DESKTOP_MODE="tauri"
      shift
      ;;
    --no-worker)
      START_WORKER=0
      shift
      ;;
    --no-deps)
      START_DEPS=0
      shift
      ;;
    --no-migrate)
      RUN_MIGRATIONS=0
      shift
      ;;
    --no-hermes-sync)
      RUN_HERMES_SYNC=0
      shift
      ;;
    --stop-deps-on-exit)
      STOP_DEPS_ON_EXIT=1
      shift
      ;;
    --)
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --*)
      fail "Unknown option: $1"
      ;;
    *)
      if [[ -z "$BOT_TOKEN" ]]; then
        BOT_TOKEN="$1"
        shift
      else
        fail "Unexpected argument: $1"
      fi
      ;;
  esac
done

if [[ -z "$BASE_URL" ]]; then
  BASE_URL="http://localhost:$API_PORT"
elif [[ "$API_PORT_SET" == "0" && "$BASE_URL" =~ ^https?://[^/:]+:([0-9]+)$ ]]; then
  API_PORT="${BASH_REMATCH[1]}"
fi
THECHAT_WEBHOOK_HOST_VALUE="${THECHAT_WEBHOOK_HOST:-127.0.0.1}"
THECHAT_WEBHOOK_PORT_VALUE="${THECHAT_WEBHOOK_PORT:-8765}"
THECHAT_WEBHOOK_PATH_VALUE="${THECHAT_WEBHOOK_PATH:-/thechat/webhook}"
THECHAT_WEBHOOK_URL_VALUE="${THECHAT_WEBHOOK_URL:-}"
THECHAT_POLL_INTERVAL_VALUE="${THECHAT_POLL_INTERVAL:-1.0}"

[[ -n "$BOT_TOKEN" ]] || fail "Missing bot token. Pass bot_... or set THECHAT_BOT_TOKEN."
[[ -d "$HERMES_SOURCE_DIR" ]] || fail "Hermes source checkout not found: $HERMES_SOURCE_DIR"
[[ -f "$HERMES_SOURCE_DIR/gateway/run.py" ]] || fail "Hermes checkout does not contain gateway/run.py: $HERMES_SOURCE_DIR"

if [[ "$HERMES_PROVIDER_VALUE" == "openrouter" && -z "${OPENROUTER_API_KEY:-}" ]]; then
  fail "OPENROUTER_API_KEY is required for provider openrouter. Add it to .env or export it."
fi

PNPM="${PNPM:-pnpm}"
UV="${UV:-uv}"
export PATH="$HOME/.bun/bin:$PATH"
if [[ -n "${BUN:-}" ]]; then
  BUN_CMD="$BUN"
elif [[ -x "$HOME/.bun/bin/bun" ]]; then
  BUN_CMD="$HOME/.bun/bin/bun"
else
  BUN_CMD="bun"
fi

command -v docker >/dev/null 2>&1 || fail "docker is required"
command -v "$PNPM" >/dev/null 2>&1 || fail "$PNPM is required"
command -v "$UV" >/dev/null 2>&1 || fail "$UV is required"
command -v curl >/dev/null 2>&1 || fail "curl is required"
command -v "$BUN_CMD" >/dev/null 2>&1 || fail "$BUN_CMD is required"

mkdir -p "$ROOT/.tmp"
API_LOG="$ROOT/.tmp/thechat-hermes-manual-api.log"
WORKER_LOG="$ROOT/.tmp/thechat-hermes-manual-worker.log"
HERMES_LOG="$ROOT/.tmp/thechat-hermes-manual-gateway.log"
DESKTOP_LOG="$ROOT/.tmp/thechat-hermes-manual-desktop.log"

PIDS=()
NAMES=()

cleanup() {
  local exit_code=$?
  trap - EXIT
  if ((${#PIDS[@]})); then
    log "Stopping manual Hermes processes"
    for pid in "${PIDS[@]}"; do
      if kill -0 "$pid" >/dev/null 2>&1; then
        kill "$pid" >/dev/null 2>&1 || true
      fi
    done
    for pid in "${PIDS[@]}"; do
      wait "$pid" >/dev/null 2>&1 || true
    done
  fi
  if [[ "$STOP_DEPS_ON_EXIT" == "1" ]]; then
    log "Stopping Compose Postgres/Redis"
    (cd "$ROOT" && docker compose stop postgres redis >/dev/null) || true
  fi
  exit "$exit_code"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

start_bg() {
  local name="$1"
  local log_file="$2"
  local cwd="$3"
  shift 3
  log "Starting $name (log: $log_file)"
  (cd "$cwd" && "$@") >"$log_file" 2>&1 &
  local pid=$!
  PIDS+=("$pid")
  NAMES+=("$name")
}

tail_log_and_fail() {
  local name="$1"
  local log_file="$2"
  warn "$name failed or did not become ready. Last log lines:"
  tail -80 "$log_file" >&2 || true
  exit 1
}

wait_for_process_alive() {
  local name="$1"
  local pid="$2"
  local log_file="$3"
  sleep 3
  if ! kill -0 "$pid" >/dev/null 2>&1; then
    tail_log_and_fail "$name" "$log_file"
  fi
}

wait_for_http() {
  local name="$1"
  local url="$2"
  local log_file="$3"
  local pid="${4:-}"
  for _ in $(seq 1 60); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    if [[ -n "$pid" ]] && ! kill -0 "$pid" >/dev/null 2>&1; then
      tail_log_and_fail "$name" "$log_file"
    fi
    sleep 1
  done
  tail_log_and_fail "$name" "$log_file"
}

wait_for_compose_service() {
  local name="$1"
  shift
  for _ in $(seq 1 60); do
    if (cd "$ROOT" && "$@") >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  fail "Timed out waiting for Compose service: $name"
}

export DATABASE_URL="${DATABASE_URL:-postgres://thechat:thechat@localhost:15543/thechat}"
export REDIS_URL="${REDIS_URL:-redis://localhost:16380}"
export REALTIME_DRIVER="${REALTIME_DRIVER:-redis}"
export REDIS_KEY_PREFIX="${REDIS_KEY_PREFIX:-thechat-hermes-manual}"
export JWT_SECRET="${JWT_SECRET:-change-me-local-thechat-jwt-secret}"
export THECHAT_SECRET_KEY="${THECHAT_SECRET_KEY:-change-me-local-thechat-secret-key}"
export THECHAT_BACKEND_PORT="$API_PORT"

API_ALREADY_RUNNING=0
if curl -fsS "$BASE_URL/health" >/dev/null 2>&1; then
  API_ALREADY_RUNNING=1
  log "Detected already-running TheChat API at $BASE_URL"
fi

if [[ "$API_ALREADY_RUNNING" == "0" && "$START_DEPS" == "1" ]]; then
  log "Starting Compose Postgres/Redis"
  (cd "$ROOT" && docker compose up -d postgres redis)
  wait_for_compose_service "postgres" docker compose exec -T postgres pg_isready -U "${POSTGRES_USER:-thechat}" -d "${POSTGRES_DB:-thechat}"
  wait_for_compose_service "redis" docker compose exec -T redis redis-cli ping
fi

if [[ "$API_ALREADY_RUNNING" == "0" && "$RUN_MIGRATIONS" == "1" ]]; then
  log "Running API migrations"
  (cd "$ROOT" && "$PNPM" --dir packages/api exec drizzle-kit migrate)
fi

if [[ "$RUN_HERMES_SYNC" == "1" ]]; then
  log "Syncing Hermes checkout"
  (cd "$HERMES_SOURCE_DIR" && "$UV" sync --frozen)
fi

if [[ "$API_ALREADY_RUNNING" == "1" ]]; then
  log "Reusing already-running TheChat API at $BASE_URL"
else
  start_bg "TheChat API" "$API_LOG" "$ROOT" env \
    DATABASE_URL="$DATABASE_URL" \
    REDIS_URL="$REDIS_URL" \
    REALTIME_DRIVER="$REALTIME_DRIVER" \
    REDIS_KEY_PREFIX="$REDIS_KEY_PREFIX" \
    JWT_SECRET="$JWT_SECRET" \
    THECHAT_SECRET_KEY="$THECHAT_SECRET_KEY" \
    THECHAT_BACKEND_PORT="$API_PORT" \
    LOG_LEVEL="${LOG_LEVEL:-info}" \
    "$BUN_CMD" run "$ROOT/packages/api/src/index.ts"
  wait_for_http "TheChat API" "$BASE_URL/health" "$API_LOG" "${PIDS[-1]}"
fi

if [[ "$START_WORKER" == "1" ]]; then
  start_bg "TheChat bot worker" "$WORKER_LOG" "$ROOT" env \
    DATABASE_URL="$DATABASE_URL" \
    REDIS_URL="$REDIS_URL" \
    REALTIME_DRIVER="$REALTIME_DRIVER" \
    REDIS_KEY_PREFIX="$REDIS_KEY_PREFIX" \
    JWT_SECRET="$JWT_SECRET" \
    THECHAT_SECRET_KEY="$THECHAT_SECRET_KEY" \
    THECHAT_BACKEND_PORT="$API_PORT" \
    LOG_LEVEL="${LOG_LEVEL:-info}" \
    "$BUN_CMD" run "$ROOT/packages/api/src/scripts/worker.ts"
  wait_for_process_alive "TheChat bot worker" "${PIDS[-1]}" "$WORKER_LOG"
fi

log "Validating Hermes platform token against $BASE_URL"
if ! curl -fsS -H "Authorization: Bearer $BOT_TOKEN" "$BASE_URL/hermes-platform/health" >/dev/null; then
  fail "TheChat rejected the bot token at $BASE_URL/hermes-platform/health"
fi

mkdir -p "$HERMES_MANUAL_HOME"
cat > "$HERMES_MANUAL_HOME/config.yaml" <<EOF
model:
  provider: $HERMES_PROVIDER_VALUE
  default: $HERMES_MODEL_VALUE
streaming:
  enabled: false
EOF

start_bg "Hermes Gateway" "$HERMES_LOG" "$HERMES_SOURCE_DIR" env \
  HERMES_HOME="$HERMES_MANUAL_HOME" \
  HERMES_E2E_SOURCE_DIR="$HERMES_SOURCE_DIR" \
  HERMES_INFERENCE_PROVIDER="$HERMES_PROVIDER_VALUE" \
  HERMES_INFERENCE_MODEL="$HERMES_MODEL_VALUE" \
  THECHAT_BASE_URL="$BASE_URL" \
  THECHAT_BOT_TOKEN="$BOT_TOKEN" \
  THECHAT_ALLOW_ALL_USERS=true \
  THECHAT_POLL_INTERVAL="$THECHAT_POLL_INTERVAL_VALUE" \
  THECHAT_WEBHOOK_HOST="$THECHAT_WEBHOOK_HOST_VALUE" \
  THECHAT_WEBHOOK_PORT="$THECHAT_WEBHOOK_PORT_VALUE" \
  THECHAT_WEBHOOK_PATH="$THECHAT_WEBHOOK_PATH_VALUE" \
  THECHAT_WEBHOOK_URL="$THECHAT_WEBHOOK_URL_VALUE" \
  LOG_LEVEL="${LOG_LEVEL:-info}" \
  OPENROUTER_API_KEY="${OPENROUTER_API_KEY:-}" \
  "$UV" run --frozen python -u "$ROOT/scripts/e2e/run-hermes-gateway-runtime.py"
wait_for_process_alive "Hermes Gateway" "${PIDS[-1]}" "$HERMES_LOG"

if [[ "$DESKTOP_MODE" == "web" ]]; then
  start_bg "TheChat desktop web dev server" "$DESKTOP_LOG" "$ROOT" env \
    THECHAT_BACKEND_URL="$BASE_URL" \
    "$PNPM" dev:desktop
elif [[ "$DESKTOP_MODE" == "tauri" ]]; then
  start_bg "TheChat Tauri desktop app" "$DESKTOP_LOG" "$ROOT" env \
    THECHAT_BACKEND_URL="$BASE_URL" \
    "$PNPM" tauri:dev
fi

cat <<EOF

Hermes manual integration is running.

TheChat API:      $BASE_URL
Hermes home:      $HERMES_MANUAL_HOME
API log:          $API_LOG
$(if [[ "$START_WORKER" == "1" ]]; then printf 'Worker log:       %s' "$WORKER_LOG"; fi)
Hermes log:       $HERMES_LOG
$(if [[ "$DESKTOP_MODE" == "web" ]]; then printf 'Desktop web UI: http://localhost:1420\nDesktop log:    %s' "$DESKTOP_LOG"; fi)
$(if [[ "$DESKTOP_MODE" == "tauri" ]]; then printf 'Desktop log:       %s' "$DESKTOP_LOG"; fi)

Manual checks:
  1. Open TheChat.
  2. Send a channel message mentioning the Hermes bot.
  3. Open a DM with the Hermes bot and send a message without a mention.

Press Ctrl-C here to stop the API/Gateway processes.
EOF

while true; do
  for index in "${!PIDS[@]}"; do
    pid="${PIDS[$index]}"
    if ! kill -0 "$pid" >/dev/null 2>&1; then
      tail_log_and_fail "${NAMES[$index]}" "$(
        case "${NAMES[$index]}" in
          "TheChat API") printf '%s' "$API_LOG" ;;
          "TheChat bot worker") printf '%s' "$WORKER_LOG" ;;
          "Hermes Gateway") printf '%s' "$HERMES_LOG" ;;
          *) printf '%s' "$DESKTOP_LOG" ;;
        esac
      )"
    fi
  done
  sleep 2
done
