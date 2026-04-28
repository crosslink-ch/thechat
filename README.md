# TheChat

Facilitate collaboration between machines and humans.

## Development

This project has very limited documentation intentionally.

Documentation rot is a real thing.

Source code + CLAUDE.md is documentation.

### PostgreSQL

Create `packages/api/.env`:

```
DATABASE_URL=postgresql://user:password@localhost:5435/thechat
```

Start a fresh PostgreSQL container and push the schema:

```bash
./scripts/restart-db.sh
```

This removes any existing `thechat-postgres` container and volume, starts a new PostgreSQL 17 instance, and runs `pnpm db:push`.

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

#### OpenTelemetry + Jaeger (trace exploration)

Start Jaeger:

```bash
docker run --rm --name jaeger -p 16686:16686 -p 4318:4318 jaegertracing/all-in-one:latest
```

Run the app:

```bash
pnpm tauri dev --features otel
```

Open http://localhost:16686, select "thechat" service, click "Find Traces".

