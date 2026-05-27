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

This starts Docker Compose services, runs database migrations, then starts the API
and bot worker. Logs are written to `.tmp/dev`.

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

Promtail reads local log files from `.tmp` by default. `pnpm dev:hermes` writes API, Hermes gateway, and desktop logs there. To use another directory:

```bash
THECHAT_DEV_LOGS_DIR=/path/to/logs docker compose up -d promtail
```

For Rust/Tauri traces, point the OTLP exporter at the local LGTM HTTP endpoint and run the app with the `otel` feature:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:14318 pnpm tauri dev --features otel
```

In Grafana Explore, select `Tempo`, choose TraceQL, and run `{ resource.service.namespace = "thechat" }`.
