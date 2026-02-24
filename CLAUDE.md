# CLAUDE.md

## Build & Development Commands

```bash
pnpm install              # Install all workspace dependencies
pnpm dev                  # Vite dev server for desktop (port 1420)
pnpm dev:desktop          # Same as above
pnpm dev:api              # ElysiaJS API server on Bun (port 3000)
pnpm tauri:dev            # Full Tauri app with Rust backend + Vite frontend
pnpm build                # Build all packages
pnpm build:desktop        # TypeScript check + Vite production build (desktop)
pnpm build:api            # Bun build (API)
pnpm tauri:build          # Full production build (frontend + Rust)
pnpm test                 # Run all test suites in parallel (typecheck, desktop, api, rust, integration)
python3 scripts/test.py desktop rust  # Run specific suites only
python3 scripts/test.py typecheck     # Run only TypeScript type checking
```

Run a single test file:
- Desktop: `pnpm --filter @thechat/desktop vitest run src/core/loop.test.ts`
- API: `pnpm --filter @thechat/api test -- src/auth/auth.test.ts`

Rust backend tests: `cd packages/desktop/src-tauri && cargo test`

**Important:** When working inside `packages/desktop/src-tauri/`, you are in a pnpm workspace — pnpm commands won't work from there. Run pnpm commands from the monorepo root.

## Monorepo Structure

This is a **pnpm workspaces monorepo** with three packages:

```
thechat/
├── package.json              # Root workspace (scripts delegate via --filter)
├── pnpm-workspace.yaml       # packages: ["packages/*"]
├── packages/
│   ├── desktop/              # Tauri 2 desktop app (@thechat/desktop)
│   │   ├── src/              # React/TypeScript frontend
│   │   └── src-tauri/        # Rust backend
│   ├── api/                  # ElysiaJS REST + MCP server (@thechat/api, runs on Bun)
│   │   └── src/
│   └── shared/               # Shared TypeScript types (@thechat/shared)
│       └── src/
```

## Architecture

### Desktop App (`packages/desktop/`)

- **React 19 + TypeScript + Vite** — entry point at `src/main.tsx` → `src/App.tsx`
- **`src/core/`** — Chat engine, independent of React:
  - `types.ts` — Re-exports shared types from `@thechat/shared`, plus desktop-only types (`ToolDefinition`, `ChatLoopOptions`, `McpToolInfo`, `QuestionRequest`)
  - `openrouter.ts` — Streaming SSE client for OpenRouter API (`https://openrouter.ai/api/v1/chat/completions`)
  - `loop.ts` — `runChatLoop()` orchestrates multi-turn conversations with automatic tool execution (unlimited roundtrips by default). Includes doom loop detection — if the same tool is called with identical args 3 times in a row, it forces a text-only response. Supports AbortSignal cancellation.
  - `system-prompt.ts` — `buildSystemPrompt()` generates platform-aware system prompt with tool usage guidelines, safety rules, and permission handling instructions
  - `truncate.ts` — `truncateToolResult()` caps tool output to 2000 lines / 50KB
  - `permission.ts` — Observer-pattern permission system; tools like write/edit/shell call `requestPermission()` which pauses until the UI resolves it
  - `question.ts` — Same pattern for asking users multiple-choice questions from within tool execution
  - `todo.ts` — In-memory todo state (`getTodos`/`setTodos`) with observer for UI sync
  - `task-runner.ts` — Sub-agent system; `runTask()` spawns a restricted chat loop with a subset of tools (no batch, task, question, or todo tools)
  - `tools/` — 15 built-in tools: `read`, `write`, `edit`, `multiedit`, `glob`, `grep`, `list`, `shell`, `get_current_time`, `batch` (parallel execution), `task` (sub-agent delegation), `question`, `todoread`, `todowrite`, `invalid` (unknown tool defense)
- **`src/hooks/useChat.ts`** — Main React hook managing chat state, conversation CRUD, message serialization (parts ↔ JSON for DB storage), and streaming lifecycle
- **`src/ChatMessage.tsx`** — Renders messages with collapsible reasoning sections, tool activity blocks, and permission/question dialogs
- **`src/CommandPalette.tsx`** — Searchable conversation switcher with keyboard navigation
- **`src/TodoPanel.tsx`** — Displays task list with status/priority badges

### Rust Backend (`packages/desktop/src-tauri/`)

- **Rust + Tauri 2** — exposes IPC commands invoked from frontend via `@tauri-apps/api`

### Shared Types (`packages/shared/`)

- Pure TypeScript type definitions shared between desktop and API packages
- Exports: `MessagePart`, `Message`, `DbMessage`, `Conversation`, `AppConfig`, `TodoItem`, `ChatParams`, `StreamEvent`, `ToolCallResult`, `StreamResult`

### API Server (`packages/api/`)

- **ElysiaJS** running on **Bun**
- Exports `App` type (`typeof app`) from `src/index.ts` for Eden Treaty type inference
- **`src/services/`** — Shared business logic used by REST routes, MCP tools, and WebSocket handlers:
  - `errors.ts` — `ServiceError` class (message + HTTP status code), thrown by services and caught by callers
- **`src/mcp/`** — Built-in MCP server (Streamable HTTP transport) at `/mcp`, via `elysia-mcp` plugin:

### Desktop ↔ API Communication

All API calls from the desktop app to the backend **must** use [Eden Treaty](https://elysiajs.com/eden/treaty/overview.html), the type-safe REST client for ElysiaJS. Do not use raw `fetch` or other HTTP clients.

- **Client setup:** `packages/desktop/src/lib/api.ts` creates a shared `api` client via `treaty<App>(API_URL)`
- **Usage pattern:** `const { data, error } = await api.route.method(body, options)`
- **Examples:**
  ```ts
  import { api } from "../lib/api";

  // GET with auth
  const { data, error } = await api.auth.me.get({
    headers: { authorization: `Bearer ${token}` },
  });

  // POST with body and auth
  const { data, error } = await api.auth.login.post({ email, password });

  // Route params + query
  const { data, error } = await api.messages({ conversationId }).get({
    query: { limit: 50 },
    headers: { authorization: `Bearer ${token}` },
  });
  ```

## Testing

- Frontend: Vitest with jsdom, globals enabled, setup in `packages/desktop/src/test-setup.ts` (clears Tauri mocks after each test)
- Backend: Rust inline `#[cfg(test)]` modules in `db.rs` and `config.rs`
- API: Bun test runner
- Tests mock the Tauri IPC layer and OpenRouter API responses

### E2E Tests

E2E tests use **tauri-driver + WebdriverIO v9** to drive the real compiled Tauri binary. Linux/WSL only (tauri-driver uses WebKitWebDriver).

**System dependencies:**
- `webkit2gtk-driver` (system package)
- `tauri-driver` (`cargo install tauri-driver --locked`)
- `xvfb` (for headless mode)

**Commands:**
```bash
pnpm test:e2e              # Run E2E tests (requires display server)
pnpm test:e2e:headless     # Run E2E tests headless via xvfb
SKIP_BUILD=1 pnpm test:e2e # Skip Tauri binary rebuild (use existing binary)
```

**Requirements:** API server + PostgreSQL must be running (`pnpm dev:api`)

## OpenCode as best practice

For things related to the core chat loop, managing subagents, skills, preventing doom loops, having good system prompts, you can reference OpenCode when it makes sense.

Don't reference OpenCode for everything. Just for things related to managing LLMs where it makes sense. Especially don't reference OpenCode for UI related stuff.

We have OpenCode checked out here /home/bruno/projects/experiment/loop/opencode
