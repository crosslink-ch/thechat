# TheChat

Facilitate collaboration between machines and humans.

## Development

This project has very limited documentation intentionally.

Documentation rot is a real thing.

Source code + CLAUDE.md is documentation.

### PostgreSQL

Create `.env`:

```
DATABASE_URL=postgresql://thechat:thechat@localhost:15543/thechat
```

Reset the Docker Compose PostgreSQL service using that `DATABASE_URL` and push the schema:

```bash
./scripts/restart-db.sh
```

This removes only the Docker Compose PostgreSQL service and its data volume, leaves other Compose services such as Redis running, starts a new PostgreSQL 17 instance, and runs `pnpm db:push`.

## Building the desktop app from source

### Prerequisites

- [Node.js](https://nodejs.org/) >= 22
- [pnpm](https://pnpm.io/) >= 9
- [Rust](https://rustup.rs/) (stable)
- Platform-specific system libraries (see below)

#### Linux (Debian/Ubuntu)

```bash
sudo apt-get install -y libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf
```

#### macOS

```bash
xcode-select --install
```

#### Windows

- [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with the "Desktop development with C++" workload
- [WebView2](https://developer.microsoft.com/en-us/microsoft-edge/webview2/) (pre-installed on Windows 10 1803+ and Windows 11)

### Build

```bash
git clone https://github.com/crosslink-ch/thechat.git
cd thechat
pnpm install
pnpm tauri build --no-bundle
```

Executable is written to `packages/desktop/src-tauri/target/release/`

### Dev mode

For the local backend stack:

```bash
pnpm dev
```

This starts Docker Compose services (including Apache Kafka), runs database
migrations, then starts the API and bot worker. Local development defaults to
`DOMAIN_EVENTS_DRIVER=kafka` with Kafka on `localhost:19092`. Logs are written
to `.tmp/dev`.

Useful options:

```bash
pnpm dev -- --skip-compose
pnpm dev -- --skip-migrate
pnpm dev -- --no-worker
```

For the desktop app:

```bash
pnpm tauri:dev
```

Starts the Vite dev server and the Tauri app with hot reload.

### Domain events and Kafka

Message creation uses a transactional outbox: the message row and a versioned
`chat.message.sent` event are committed in one PostgreSQL transaction. The API
does not contact Kafka. The event stores IDs rather than message content, but it
also captures the eligible target-bot IDs, message kind, and automation depth in
the message transaction. This keeps replay routing stable when bots are added or
renamed.
The worker reloads the canonical message and sender, then uses the existing
BullMQ bot queue. System-failure messages never trigger bots, and bot-authored
chains stop at a causal depth of eight.

`DOMAIN_EVENTS_DRIVER=outbox` (the application default) claims and handles
outbox events directly, so tests and existing deployments do not need Kafka.
`DOMAIN_EVENTS_DRIVER=kafka` runs an outbox relay and consumes the shared topic
with KafkaJS. Message events are keyed by conversation ID, so Kafka preserves
the relay's order within a conversation partition. Concurrent source
transactions do not claim a strict client-request total order.

Defaults are:

```text
DOMAIN_EVENTS_MAX_ATTEMPTS=25
DOMAIN_EVENTS_LOCK_TIMEOUT_MS=300000
KAFKA_TOPIC=thechat.domain-events.v1
KAFKA_DEAD_LETTER_TOPIC=thechat.domain-events.v1.dlq
KAFKA_AUTO_CREATE_TOPICS=false
KAFKA_TOPIC_PARTITIONS=3
KAFKA_FROM_BEGINNING=true
KAFKA_CONSUMER_GROUP=thechat-message-events-v1
KAFKA_CLIENT_ID=thechat-worker
```

To run the env-gated real broker tests:

```bash
docker compose up -d postgres redis kafka
pnpm db:migrate
KAFKA_BROKERS=localhost:19092 pnpm test:kafka
```

To run the complete bot suite through Kafka instead of direct outbox handling,
also set `THECHAT_BOTS_TEST_EVENTS_DRIVER=kafka` and use a unique topic and
consumer group. Ordinary tests force outbox mode and remain broker-free.

Kafka mode requires comma-separated `KAFKA_BROKERS`. TLS is enabled with
`KAFKA_SSL=true`; optional SASL uses `KAFKA_SASL_MECHANISM` (`plain`,
`scram-sha-256`, or `scram-sha-512`), `KAFKA_SASL_USERNAME`, and
`KAFKA_SASL_PASSWORD`. Local development sets
`KAFKA_AUTO_CREATE_TOPICS=true`; production should leave it false and
pre-create both the main and DLQ topics with the required partition and
replication settings. New consumer groups replay retained events by default;
set `KAFKA_FROM_BEGINNING=false` only when intentionally starting at the
current end. For a new event type or version, deploy consumer support before any
producer can emit it; an older consumer intentionally skips unknown types and
quarantines unsupported versions of types it already knows.

Delivery is at least once. A relay crash after Kafka accepts an event but before
the outbox row is marked published can produce a duplicate. Consumers must be
idempotent; message handling uses stable event target IDs, the unique
`bot_invocations(bot_id, trigger_message_id)` key, and deterministic BullMQ job
IDs. A failed BullMQ enqueue leaves the source event unacknowledged, so retry
reconciles the already-created invocation. This does not claim exactly-once
processing.

Malformed Kafka records, unsupported versions of known event types, invalid
event-specific payloads, and explicitly classified permanent handler failures
are published to `KAFKA_DEAD_LETTER_TOPIC` before their source offsets are
acknowledged. Kafka auto-commit is disabled; the consumer commits the next
offset only after successful handling, an intentional unknown type skip, or an
acknowledged DLQ publication. Transient handler, database, and Redis failures
remain uncommitted for at-least-once replay. DLQ metadata records the original
byte counts and stores bounded key/value excerpts so a near-limit poison record
cannot make its own DLQ write oversized. Invalid/permanent direct-outbox events
are quarantined immediately; transient failures back off and are quarantined
with `dead_at` after `DOMAIN_EVENTS_MAX_ATTEMPTS`. Later rows for that
conversation can then advance. Review and repair a quarantined row before
clearing `dead_at`, resetting `attempts`, and setting `available_at=now()`.

The `apache/kafka:4.3.1` KRaft image in `compose.yml` is digest-pinned but remains
a single-node, development-only service. Production should use a managed or
operator-backed multi-broker Kafka cluster, retain both topics appropriately,
and supply TLS/SASL credentials via secrets. Monitor worker restarts, consumer
lag, DLQ traffic, old unpublished rows, and `event_outbox.dead_at`. Published
outbox rows should be pruned or archived under an operations-defined retention
policy. Do not use the Compose broker for production.

### Rust profiling

The Rust backend uses `tracing` for instrumentation, with optional backends behind cargo feature flags. Release builds have zero overhead.

#### Log levels

Controlled by the `THECHAT_TRACING` env var using `tracing` [EnvFilter](https://docs.rs/tracing-subscriber/latest/tracing_subscriber/filter/struct.EnvFilter.html) syntax — comma-separated `target=level` pairs where the target is typically the crate name:

```bash
THECHAT_TRACING=thechat=trace pnpm tauri:dev                       # our code at trace, others at default
THECHAT_TRACING=thechat=trace,reqwest=debug,warn pnpm tauri:dev     # per-crate control
THECHAT_TRACING=trace pnpm tauri:dev                                # everything at trace (very noisy)
```

If unset, defaults to `thechat=debug,info` in dev builds, `info` in release.

#### tokio-console (async task introspection)

```bash
pnpm tauri dev --features tokio-console
# In another terminal:
tokio-console                                # connects to localhost:6669
```

Requires `tokio-console` CLI: `cargo install tokio-console`

#### Local Grafana LGTM

Start the local observability stack:

```bash
docker compose up -d otel-lgtm promtail
```

Open Grafana at http://localhost:13300. The default local credentials are `admin` / `admin`.

TheChat intentionally uses different local observability ports from the AzulAI dev stack, so both projects can run at the same time:

- Grafana: `13300` -> container `3000`
- OTLP gRPC: `14317` -> container `4317`
- OTLP HTTP: `14318` -> container `4318`

Override them if needed:

```bash
GRAFANA_PORT=23300 OTEL_GRPC_PORT=24317 OTEL_HTTP_PORT=24318 docker compose up -d otel-lgtm promtail
```

The `TheChat Dev` Grafana folder is provisioned from `deployment/local/grafana/dashboards`. It includes dashboards for local logs and OpenTelemetry span metrics/traces.

Promtail reads local log files from `.tmp` by default (`pnpm dev:services` mounts `.tmp/dev` instead and writes API and worker logs there; `pnpm dev:hermes` writes API, Hermes gateway, and desktop logs to `.tmp`). Files are matched recursively, so either mount works. To use another directory:

```bash
THECHAT_DEV_LOGS_DIR=/path/to/logs docker compose up -d promtail
```

Dev builds of the desktop app (`pnpm tauri:dev`) also mirror their logs — including webview logs from the frontend — as JSON to `$THECHAT_DEV_LOGS_DIR/desktop.log` (default `.tmp/dev/desktop.log`), so they appear in the `TheChat Dev Logs` dashboard under `job=thechat-desktop` without extra setup. Rust-side `tracing` events are not included; use `THECHAT_TRACING` (stderr) or the `otel` feature for those.

For Rust/Tauri traces, point the OTLP exporter at the local LGTM HTTP endpoint and run the app with the `otel` feature:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:14318 pnpm tauri dev --features otel
```

In Grafana Explore, select `Tempo`, choose TraceQL, and run `{ resource.service.namespace = "thechat" }`.
