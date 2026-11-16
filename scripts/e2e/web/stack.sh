#!/usr/bin/env bash
# Isolated loopback stack for the browser E2E suite (pnpm test:e2e:web).
#
#   scripts/e2e/web/stack.sh up      # (re)start everything on a fresh database
#   scripts/e2e/web/stack.sh status
#   scripts/e2e/web/stack.sh down
#
# Starts, all on 127.0.0.1: LocalStack S3 on :19000 with a versioned, CORS-enabled
# bucket; the API on :13300 and the pg-boss worker on a fresh `thechat_e2e`
# database and Redis key prefix `thechat-e2e` (next to the compose Postgres/Redis
# from the repository-root .env); the compiled web app (vite preview) on :1422,
# the suite's default URLs. The API runs in loopback-only E2E mode (outbound
# HTTP refused). Synthetic VAPID keys are generated for the opt-in
# web-push.spec.ts; start the stack with THECHAT_WEB_E2E_REAL_PUSH=1 for that
# spec, which lifts loopback-only mode because the API must reach the push
# service. Logs, pids and the generated environment live in
# $THECHAT_WEB_E2E_STACK_DIR (default ~/.cache/thechat/web-e2e-stack).
set -uo pipefail
REPO=${THECHAT_REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)}
STATE=${THECHAT_WEB_E2E_STACK_DIR:-$HOME/.cache/thechat/web-e2e-stack}
S3_IMAGE=${THECHAT_WEB_E2E_S3_IMAGE:-localstack/localstack:4.4.0}
S3_CONTAINER=thechat-web-e2e-s3
API=http://127.0.0.1:13300 WEB=http://127.0.0.1:1422 S3=http://127.0.0.1:19000
cd "$REPO" || exit 1
mkdir -p "$STATE"

write_env() {
  # Shell-quoted exports: sourced values beat anything exported in the caller's
  # shell (Bun prefers process env over --env-file).
  local vapid
  vapid=$(cd packages/api && bun -e "import w from 'web-push'; const k = w.generateVAPIDKeys(); console.log(k.publicKey, k.privateKey)") || return 1
  VAPID="$vapid" STATE="$STATE" python3 - <<'PY'
import os, pathlib, re, shlex
from urllib.parse import urlsplit, urlunsplit
src = pathlib.Path('.env') if pathlib.Path('.env').exists() else pathlib.Path('.env.example')
env = {}
for line in src.read_text().splitlines():
    m = re.match(r'^([A-Z0-9_]+)=(.*)$', line)
    if m: env[m[1]] = m[2].strip().strip('"\'')
def loopback(url, path=None):
    u = urlsplit(url)
    netloc = u.netloc.replace('localhost', '127.0.0.1')
    return urlunsplit((u.scheme, netloc, path if path is not None else u.path, '', ''))
pub, priv = os.environ['VAPID'].split()
env.update(
  DATABASE_URL=loopback(env.get('DATABASE_URL') or 'postgresql://thechat:thechat@127.0.0.1:15543/thechat', '/thechat_e2e'),
  REDIS_URL=loopback(env.get('REDIS_URL') or 'redis://127.0.0.1:16380'),
  REDIS_KEY_PREFIX='thechat-e2e', REALTIME_DRIVER='redis',
  THECHAT_BACKEND_HOST='127.0.0.1', THECHAT_BACKEND_PORT='13300',
  THECHAT_BACKEND_URL='http://127.0.0.1:13300', BETTER_AUTH_URL='http://127.0.0.1:13300',
  THECHAT_WEB_API_URL='http://127.0.0.1:13300', THECHAT_WEB_WS_URL='ws://127.0.0.1:13300/ws',
  THECHAT_WEB_ORIGINS='http://127.0.0.1:1422', THECHAT_WEB_ALLOW_INSECURE_LOOPBACK='true',
  THECHAT_E2E_LOOPBACK_ONLY='1', THECHAT_E2E_RUN_ID='web-e2e', SMTP_HOST='127.0.0.1',
  REQUIRE_EMAIL_VERIFICATION='false',
  ATTACHMENT_S3_BUCKET='thechat-e2e', ATTACHMENT_S3_REGION='us-east-1',
  ATTACHMENT_S3_ENDPOINT='http://127.0.0.1:19000', ATTACHMENT_S3_PUBLIC_ENDPOINT='',
  ATTACHMENT_S3_FORCE_PATH_STYLE='true',
  AWS_ACCESS_KEY_ID='test', AWS_SECRET_ACCESS_KEY='test', AWS_REGION='us-east-1', AWS_EC2_METADATA_DISABLED='true',
  WEB_PUSH_VAPID_PUBLIC_KEY=pub, WEB_PUSH_VAPID_PRIVATE_KEY=priv, WEB_PUSH_SUBJECT='mailto:web-e2e@example.invalid',
  THECHAT_OTEL_ENABLED='false', OTEL_SDK_DISABLED='true')
# Not production (auth rate limits); unset also keeps the web build a production bundle.
env.pop('NODE_ENV', None)
if os.environ.get('THECHAT_WEB_E2E_REAL_PUSH') == '1':
    env.pop('THECHAT_E2E_LOOPBACK_ONLY')  # the API's test push goes to Google's push service
out = pathlib.Path(os.environ['STATE']) / 'env.sh'
out.write_text(''.join(f'export {k}={shlex.quote(v)}\n' for k, v in env.items()))
out.chmod(0o600)
PY
}

# Run a command in packages/api with the stack environment.
in_api() { ( set -a; . "$STATE/env.sh"; set +a; cd packages/api && exec "$@" ); }

start_s3() {
  docker rm -f "$S3_CONTAINER" >/dev/null 2>&1
  docker run -d --name "$S3_CONTAINER" -e SERVICES=s3 -e PERSISTENCE=0 -e LS_LOG=warn \
    -p 127.0.0.1:19000:4566 "$S3_IMAGE" >/dev/null || return 1
  for _ in $(seq 1 120); do
    curl -fs "$S3/_localstack/health" 2>/dev/null | grep -Eq '"s3": *"(available|running)"' && break
    sleep 1
  done
  # Same bucket setup as scripts/e2e/attachments-ui-flow.py.
  in_api bun -e '
import { CreateBucketCommand, PutBucketCorsCommand, PutBucketVersioningCommand, S3Client } from "@aws-sdk/client-s3";
const client = new S3Client({ region: "us-east-1", endpoint: process.env.ATTACHMENT_S3_ENDPOINT, forcePathStyle: true });
const Bucket = process.env.ATTACHMENT_S3_BUCKET;
await client.send(new CreateBucketCommand({ Bucket }));
await client.send(new PutBucketVersioningCommand({ Bucket, VersioningConfiguration: { Status: "Enabled" } }));
await client.send(new PutBucketCorsCommand({ Bucket, CORSConfiguration: { CORSRules: [{
  AllowedOrigins: ["*"], AllowedMethods: ["GET", "PUT", "HEAD"], AllowedHeaders: ["*"],
  ExposeHeaders: ["ETag", "x-amz-version-id", "x-amz-checksum-sha256"] }] } }));
console.log(`bucket ${Bucket} ready (versioned)`);'
}

# Drop and recreate thechat_e2e and clear the stack's Redis keys.
fresh_state() {
  in_api bun -e '
import pg from "pg";
import Redis from "ioredis";
const url = new URL(process.env.DATABASE_URL);
const name = url.pathname.slice(1);
url.pathname = "/postgres";
const admin = new pg.Client({ connectionString: url.toString() });
await admin.connect();
await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
await admin.query(`CREATE DATABASE "${name}"`);
await admin.end();
const redis = new Redis(process.env.REDIS_URL);
let cursor = "0", removed = 0;
do {
  const [next, keys] = await redis.scan(cursor, "MATCH", `${process.env.REDIS_KEY_PREFIX}*`, "COUNT", 1000);
  cursor = next;
  if (keys.length) removed += await redis.del(...keys);
} while (cursor !== "0");
redis.disconnect();
console.log(`fresh database ${name}; removed ${removed} Redis keys`);'
}

wait_http() { for _ in $(seq 1 "$2"); do curl -fs "$1" >/dev/null 2>&1 && return 0; sleep 1; done; return 1; }

# setsid gives each service its own process group, so `down` stops children too.
spawn() { local name=$1; shift; ( set -a; . "$STATE/env.sh"; set +a; exec setsid "$@" ) >"$STATE/$name.log" 2>&1 & echo $! >"$STATE/$name.pid"; }

up() {
  down >/dev/null 2>&1
  # Keep the previous run's logs: a restart must not erase failure evidence.
  for f in "$STATE"/*.log; do [ -e "$f" ] && mv -f "$f" "$f.prev"; done
  write_env || { echo "could not write the stack environment"; return 1; }
  if ! fresh_state >"$STATE/db.log" 2>&1; then
    docker compose up -d --wait postgres redis >"$STATE/compose.log" 2>&1
    fresh_state >"$STATE/db.log" 2>&1 || { echo "Postgres/Redis unavailable, see $STATE/db.log"; return 1; }
  fi
  start_s3 >"$STATE/s3.log" 2>&1 || { echo "S3 failed, see $STATE/s3.log"; return 1; }
  in_api bun run drizzle-kit migrate >"$STATE/migrate.log" 2>&1 || { echo "migrate failed, see $STATE/migrate.log"; return 1; }
  in_api bun run src/scripts/queue-setup.ts >"$STATE/queue-setup.log" 2>&1 || { echo "queue setup failed"; return 1; }
  ( cd packages/api && spawn api bun run src/index.ts )
  ( cd packages/api && spawn worker bun run src/scripts/worker.ts )
  ( set -a; . "$STATE/env.sh"; set +a; unset NODE_ENV; pnpm --filter @thechat/web build ) >"$STATE/web-build.log" 2>&1 \
    || { echo "web build failed, see $STATE/web-build.log"; return 1; }
  ( cd packages/web && spawn web pnpm exec vite preview --host 127.0.0.1 --port 1422 --strictPort )
  wait_http "$API/health" 60 && wait_http "$WEB/" 60 || { echo "stack not healthy, see $STATE/*.log"; return 1; }
  for _ in $(seq 1 30); do grep -q 'durable queues are running' "$STATE/worker.log" && break; sleep 1; done
  status && echo "stack up; logs in $STATE"
}

# SIGTERM a service's process group and wait for it; SIGKILL what is left after
# 20 s. After a full suite run the worker can keep shutting down indefinitely
# (a job in flight), and each later `up` would leave another worker behind.
stop_group() {
  local pid=$1
  kill -TERM -- -"$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || return 0
  for _ in $(seq 1 20); do
    kill -0 -- -"$pid" 2>/dev/null || return 0
    sleep 1
  done
  kill -KILL -- -"$pid" 2>/dev/null
}

down() {
  for s in web worker api; do
    if [ -f "$STATE/$s.pid" ]; then
      stop_group "$(cat "$STATE/$s.pid")"
      rm -f "$STATE/$s.pid"
    fi
  done
  docker rm -f "$S3_CONTAINER" >/dev/null 2>&1
  echo "stack down"
}

status() {
  local ok=0
  curl -fs "$API/health" && echo || { echo "API down"; ok=1; }
  curl -fs -o /dev/null "$WEB/" && echo "web ok" || { echo "web down"; ok=1; }
  curl -fs "$S3/_localstack/health" >/dev/null && echo "s3 ok" || { echo "s3 down"; ok=1; }
  grep -q 'durable queues are running' "$STATE/worker.log" 2>/dev/null && echo "worker ok" || { echo "worker not ready"; ok=1; }
  return $ok
}

case "${1:-status}" in up|down|status) "$1" ;; *) echo "usage: $0 up|down|status" >&2; exit 2 ;; esac
