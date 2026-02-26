#!/usr/bin/env bash
set -euo pipefail

CONTAINER_NAME="thechat-postgres"
VOLUME_NAME="thechat-postgres-data"

POSTGRES_USER="user"
POSTGRES_PASSWORD="password"
POSTGRES_DB="thechat"
POSTGRES_PORT="5435"

echo "Stopping container '$CONTAINER_NAME' if running..."
docker rm -f "$CONTAINER_NAME" 2>/dev/null || true

echo "Removing volume '$VOLUME_NAME' if exists..."
docker volume rm "$VOLUME_NAME" 2>/dev/null || true

echo "Creating fresh container..."
docker run -d \
  --name "$CONTAINER_NAME" \
  -e POSTGRES_USER="$POSTGRES_USER" \
  -e POSTGRES_PASSWORD="$POSTGRES_PASSWORD" \
  -e POSTGRES_DB="$POSTGRES_DB" \
  -p "$POSTGRES_PORT":5432 \
  -v "$VOLUME_NAME":/var/lib/postgresql/data \
  postgres:17-alpine

echo "Waiting for PostgreSQL to be ready..."
until docker exec "$CONTAINER_NAME" pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1; do
  sleep 0.5
done

echo "PostgreSQL is ready on port $POSTGRES_PORT"
echo "Connection: postgresql://$POSTGRES_USER:$POSTGRES_PASSWORD@localhost:$POSTGRES_PORT/$POSTGRES_DB"

echo "Pushing database schema..."
cd "$(dirname "$0")/.."
pnpm db:push
