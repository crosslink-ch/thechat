#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${THECHAT_ENV_FILE:-$ROOT_DIR/.env}"

CONTAINER_NAME="${HERMES_CONTAINER:-hermes-thechat-manual}"
IMAGE="${HERMES_IMAGE:-nousresearch/hermes-agent:latest}"
HOST="${HERMES_HOST:-127.0.0.1}"
API_PORT="${HERMES_PORT:-18642}"
DASHBOARD_PORT="${HERMES_DASHBOARD_PORT:-19119}"
DATA_DIR="${HERMES_DATA_DIR:-$HOME/.hermes-thechat-manual}"
KEY_FILE="${HERMES_API_KEY_FILE:-$HOME/.config/thechat-hermes-manual/api-server-key}"
HERMES_PROVIDER="${HERMES_PROVIDER:-}"
HERMES_MODEL="${HERMES_MODEL:-}"

for cmd in docker curl node; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Missing required command: $cmd" >&2
    exit 1
  fi
done

read_env_value() {
  local key="$1"
  [[ -f "$ENV_FILE" ]] || return 0
  node - "$ENV_FILE" "$key" <<'NODE'
const fs = require("node:fs");

const [envFile, key] = process.argv.slice(2);
const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const pattern = new RegExp(`^\\s*(?:export\\s+)?${escapedKey}\\s*=`);
const line = fs.readFileSync(envFile, "utf8")
  .split(/\r?\n/)
  .find((entry) => pattern.test(entry));

if (!line) process.exit(0);

let value = line.replace(pattern, "").trim();
const quote = value[0];

if (quote === '"' || quote === "'") {
  const endQuote = value.indexOf(quote, 1);
  if (endQuote === -1) process.exit(0);
  value = value.slice(1, endQuote);
} else {
  value = value.replace(/\s+#.*$/, "");
}

process.stdout.write(value);
NODE
}

mkdir -p "$DATA_DIR"
mkdir -p "$(dirname "$KEY_FILE")"

if [[ -z "${HERMES_API_KEY:-}" ]]; then
  HERMES_API_KEY="$(read_env_value HERMES_API_KEY)"
fi

if [[ -z "${HERMES_API_KEY:-}" ]]; then
  if [[ -f "$KEY_FILE" ]]; then
    HERMES_API_KEY="$(<"$KEY_FILE")"
  else
    if ! command -v openssl >/dev/null 2>&1; then
      echo "Missing openssl. Set HERMES_API_KEY manually or install openssl." >&2
      exit 1
    fi
    HERMES_API_KEY="$(openssl rand -hex 24)"
    printf '%s\n' "$HERMES_API_KEY" > "$KEY_FILE"
    chmod 600 "$KEY_FILE"
  fi
fi

if ((${#HERMES_API_KEY} < 8)); then
  echo "HERMES_API_KEY must be at least 8 characters" >&2
  exit 1
fi

if [[ -z "${OPENROUTER_API_KEY:-}" ]]; then
  OPENROUTER_API_KEY="$(read_env_value OPENROUTER_API_KEY)"
fi

if [[ -z "$OPENROUTER_API_KEY" ]]; then
  echo "Missing OPENROUTER_API_KEY. Add it to $ENV_FILE or export it before running this script." >&2
  exit 1
fi

if [[ -z "$HERMES_PROVIDER" ]]; then
  HERMES_PROVIDER="$(read_env_value HERMES_PROVIDER)"
fi
HERMES_PROVIDER="${HERMES_PROVIDER:-openrouter}"

if [[ -z "$HERMES_MODEL" ]]; then
  HERMES_MODEL="$(read_env_value HERMES_MODEL)"
fi
HERMES_MODEL="${HERMES_MODEL:-deepseek/deepseek-v4-pro}"

echo "Configuring Hermes model: $HERMES_PROVIDER / $HERMES_MODEL"
docker run --rm \
  -v "$DATA_DIR:/opt/data" \
  "$IMAGE" config set model.provider "$HERMES_PROVIDER" >/dev/null
docker run --rm \
  -v "$DATA_DIR:/opt/data" \
  "$IMAGE" config set model.default "$HERMES_MODEL" >/dev/null

docker_args=(
  run -d
  --name "$CONTAINER_NAME"
  -v "$DATA_DIR:/opt/data"
  -p "$HOST:$API_PORT:8642"
  -p "$HOST:$DASHBOARD_PORT:9119"
  -e API_SERVER_ENABLED=true
  -e API_SERVER_HOST=0.0.0.0
  -e API_SERVER_PORT=8642
  -e "API_SERVER_KEY=$HERMES_API_KEY"
  -e "API_SERVER_CORS_ORIGINS=*"
  -e "API_SERVER_MODEL_NAME=$HERMES_MODEL"
  -e HERMES_DASHBOARD=1
  -e "HERMES_INFERENCE_PROVIDER=$HERMES_PROVIDER"
  -e "HERMES_INFERENCE_MODEL=$HERMES_MODEL"
)

for env_name in \
  OPENAI_API_KEY \
  ANTHROPIC_API_KEY \
  OPENROUTER_API_KEY \
  NOUS_API_KEY \
  GOOGLE_API_KEY \
  GEMINI_API_KEY; do
  if [[ -n "${!env_name:-}" ]]; then
    docker_args+=(-e "$env_name=${!env_name}")
  fi
done

docker_args+=("$IMAGE" gateway run)

echo "Removing existing Hermes container '$CONTAINER_NAME' if it exists..."
docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true

echo "Starting Hermes Gateway container..."
docker "${docker_args[@]}" >/dev/null

echo "Waiting for Hermes Gateway health check..."
for _ in {1..120}; do
  if curl -fsS -H "Authorization: Bearer $HERMES_API_KEY" "http://localhost:$API_PORT/health" >/dev/null 2>&1; then
    echo "Hermes Gateway is ready."
    echo
    echo "Use these values in TheChat desktop:"
    echo "  Hermes Base URL: http://localhost:$API_PORT"
    echo "  Hermes API Key:  $HERMES_API_KEY"
    echo "  Hermes Model:    $HERMES_PROVIDER / $HERMES_MODEL"
    echo
    echo "Dashboard, if available: http://localhost:$DASHBOARD_PORT"
    exit 0
  fi
  sleep 1
done

echo "Hermes Gateway did not become healthy in time." >&2
echo "Recent logs:" >&2
docker logs --tail 80 "$CONTAINER_NAME" >&2 || true
exit 1
