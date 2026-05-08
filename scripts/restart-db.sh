#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env"
COMPOSE_FILE="$ROOT_DIR/compose.yml"
COMPOSE_SERVICE="postgres"

LEGACY_CONTAINER_NAME="thechat-postgres"
LEGACY_VOLUME_NAME="thechat-postgres-data"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE. Create it with DATABASE_URL=postgresql://thechat:thechat@localhost:15543/thechat" >&2
  exit 1
fi

if [[ ! -f "$COMPOSE_FILE" ]]; then
  echo "Missing $COMPOSE_FILE" >&2
  exit 1
fi

eval "$(
  node - "$ENV_FILE" <<'NODE'
const fs = require("node:fs");

function fail(message) {
  console.error(message);
  process.exit(1);
}

function shellQuote(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function readDatabaseUrl(envFile) {
  const lines = fs.readFileSync(envFile, "utf8").split(/\r?\n/);
  const line = lines.find((entry) =>
    /^\s*(?:export\s+)?DATABASE_URL\s*=/.test(entry)
  );

  if (!line) {
    fail(`Missing DATABASE_URL in ${envFile}`);
  }

  let value = line.replace(/^\s*(?:export\s+)?DATABASE_URL\s*=\s*/, "").trim();
  const quote = value[0];

  if (quote === '"' || quote === "'") {
    const endQuote = value.indexOf(quote, 1);
    if (endQuote === -1) {
      fail(`DATABASE_URL in ${envFile} has an unterminated quote`);
    }
    value = value.slice(1, endQuote);
  } else {
    value = value.replace(/\s+#.*$/, "");
  }

  if (!value) {
    fail(`DATABASE_URL in ${envFile} is empty`);
  }

  return value;
}

const databaseUrl = readDatabaseUrl(process.argv[2]);

let parsed;
try {
  parsed = new URL(databaseUrl);
} catch {
  fail("DATABASE_URL must be a valid PostgreSQL connection URL");
}

if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
  fail("DATABASE_URL must use the postgres:// or postgresql:// protocol");
}

const user = decodeURIComponent(parsed.username);
const password = decodeURIComponent(parsed.password);
const database = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
const host = parsed.hostname;
const port = parsed.port || "5432";

if (!user) fail("DATABASE_URL must include a database username");
if (!password) fail("DATABASE_URL must include a database password");
if (!database) fail("DATABASE_URL must include a database name");
if (!host) fail("DATABASE_URL must include a database host");

for (const [key, value] of Object.entries({
  POSTGRES_USER: user,
  POSTGRES_PASSWORD: password,
  POSTGRES_DB: database,
  POSTGRES_HOST: host,
  POSTGRES_PORT: port,
})) {
  console.log(`${key}=${shellQuote(value)}`);
}
NODE
)"

case "$POSTGRES_HOST" in
  localhost|127.0.0.1|::1|"[::1]") ;;
  *)
    echo "DATABASE_URL host must point to localhost for this reset script; got '$POSTGRES_HOST'" >&2
    exit 1
    ;;
esac

export POSTGRES_USER POSTGRES_PASSWORD POSTGRES_DB POSTGRES_PORT

cd "$ROOT_DIR"

POSTGRES_VOLUME_NAME="$(
  docker compose config --format json | node -e '
const fs = require("node:fs");

function fail(message) {
  console.error(message);
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(0, "utf8"));
const serviceName = process.argv[1] || "postgres";
const service = config.services?.[serviceName];
if (!service) fail(`Compose service ${serviceName} was not found`);

const mount = (service.volumes || []).find(
  (volume) => volume.type === "volume" && volume.target === "/var/lib/postgresql/data"
);
if (!mount?.source) fail(`Compose service ${serviceName} does not define a PostgreSQL data volume`);

const volume = config.volumes?.[mount.source];
process.stdout.write(volume?.name || `${config.name}_${mount.source}`);
' "$COMPOSE_SERVICE"
)"

echo "Stopping PostgreSQL Compose service and removing only its database volume..."
docker compose rm --force --stop "$COMPOSE_SERVICE"

echo "Removing Docker Compose volume '$POSTGRES_VOLUME_NAME'..."
docker volume rm "$POSTGRES_VOLUME_NAME" 2>/dev/null || true

echo "Removing legacy standalone container '$LEGACY_CONTAINER_NAME' if it exists..."
docker rm -f "$LEGACY_CONTAINER_NAME" 2>/dev/null || true

echo "Removing legacy standalone volume '$LEGACY_VOLUME_NAME' if it exists..."
docker volume rm "$LEGACY_VOLUME_NAME" 2>/dev/null || true

echo "Starting PostgreSQL with Docker Compose..."
docker compose up -d "$COMPOSE_SERVICE"

echo "Waiting for PostgreSQL to be ready..."
until docker compose exec -T "$COMPOSE_SERVICE" pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1; do
  sleep 0.5
done

echo "PostgreSQL is ready on port $POSTGRES_PORT"
echo "Connection: postgresql://$POSTGRES_USER:***@localhost:$POSTGRES_PORT/$POSTGRES_DB"

echo "Pushing database schema..."
pnpm db:push
