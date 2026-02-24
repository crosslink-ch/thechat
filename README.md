# TheChat

Bot and human collaboration app.

## Development

This project has very limited documentation intentionally.

Documentation rot is a real thing.

Source code + CLAUDE.md is documentation.

### PostgreSQL

Create `packages/api/.env`:

```
DATABASE_URL=postgresql://user:password@localhost:5432/thechat
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
- Platform-specific dependencies (see below)

#### Linux (Debian/Ubuntu)

```bash
sudo apt-get install -y libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf
```

#### macOS

Xcode Command Line Tools:

```bash
xcode-select --install
```

#### Windows

- [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with the "Desktop development with C++" workload
- [WebView2](https://developer.microsoft.com/en-us/microsoft-edge/webview2/) (pre-installed on Windows 10 1803+ and Windows 11)

### Build

```bash
pnpm install
pnpm tauri:build
```

Installers will be in `packages/desktop/src-tauri/target/release/bundle/`.

### Dev mode

```bash
pnpm tauri:dev
```

This starts the Vite dev server and the Tauri app with hot reload.
