# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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
pnpm test                 # Run tests across all packages
pnpm test:desktop         # Run Vitest tests for desktop
pnpm test:api             # Run Bun tests for API
```

Run a single test file: `pnpm --filter @thechat/desktop vitest run src/core/loop.test.ts`

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
│   ├── api/                  # ElysiaJS + GraphQL server (@thechat/api, runs on Bun)
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
- **`db.rs`** — SQLite (rusqlite, bundled) with `Mutex<Connection>` for thread safety. Tables: `conversations`, `messages`
- **`config.rs`** — Loads `config.json` (API key, model, MCP servers). Search order: CWD → parent → grandparent → great-grandparent → beside executable → `~/.config/thechat/config.json`
- **`fs.rs`** — File system commands: `fs_read_file`, `fs_write_file`, `fs_edit_file`, `fs_glob`, `fs_grep`, `fs_list_dir`. Shared constants for line limits, result caps, and default ignores (node_modules, .git, dist, target, etc.)
- **`shell.rs`** — `execute_shell_command` spawns via login shell with timeout (default 120s)
- **`mcp.rs`** — Full MCP (Model Context Protocol) client: spawns external tool servers, JSON-RPC v2 handshake, tool discovery, tool invocation, graceful shutdown. `McpManager` holds multiple named `McpClient` instances.
- **`lib.rs`** — Tauri command handlers and app setup. SQLite DB stored at `~/.local/share/thechat/thechat.db`

### Shared Types (`packages/shared/`)

- Pure TypeScript type definitions shared between desktop and API packages
- Exports: `MessagePart`, `Message`, `DbMessage`, `Conversation`, `AppConfig`, `TodoItem`, `ChatParams`, `StreamEvent`, `ToolCallResult`, `StreamResult`

### API Server (`packages/api/`)

- **ElysiaJS + GraphQL Yoga** running on **Bun**
- GraphQL playground at `http://localhost:3000/graphql`

### Data Flow (Desktop)

1. User sends message → `useChat` saves to SQLite via Tauri IPC → calls `runChatLoop()`
2. `runChatLoop()` streams from OpenRouter, emitting `StreamEvent`s that update React state in real-time
3. If the model returns tool calls, the loop executes tools and continues automatically (with doom loop detection as a safety net)
4. Tools that need user consent (write, edit, shell) pause via the permission system until the UI resolves
5. Final assistant response is saved to SQLite

### Configuration

`config.json` at monorepo root (gitignored):
```json
{
  "api_key": "sk-or-v1-...",
  "model": "google/gemini-3.1-pro-preview",
  "mcp_servers": {
    "server-name": {
      "command": "npx",
      "args": ["-y", "@some/mcp-server"],
      "env": {}
    }
  }
}
```

## Testing

- Frontend: Vitest with jsdom, globals enabled, setup in `packages/desktop/src/test-setup.ts` (clears Tauri mocks after each test)
- Backend: Rust inline `#[cfg(test)]` modules in `db.rs` and `config.rs`
- API: Bun test runner
- Tests mock the Tauri IPC layer and OpenRouter API responses
- Tool tests live alongside their source in `packages/desktop/src/core/tools/*.test.ts`

## OpenCode as best practice

For things related to the core chat loop, managing subagents, skills, preventing doom loops, having good system prompts, you can reference OpenCode when it makes sense.

Don't reference OpenCode for everything. Just for things related to managing LLMs where it makes sense. Especially don't reference OpenCode for UI related stuff.

We have OpenCode checked out here /home/bruno/projects/experiment/loop/opencode
