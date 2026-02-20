# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Development Commands

```bash
pnpm install              # Install dependencies
pnpm dev                  # Vite dev server only (port 1420)
pnpm tauri dev            # Full Tauri app with Rust backend + Vite frontend
pnpm build                # TypeScript check + Vite production build
pnpm tauri build          # Full production build (frontend + Rust)
pnpm test                 # Run Vitest tests once
pnpm test:watch           # Run Vitest in watch mode
```

Run a single test file: `pnpm vitest run src/core/loop.test.ts`

Rust backend tests: `cd src-tauri && cargo test`

**Important:** When working inside `src-tauri/`, you are in a pnpm workspace — pnpm commands won't work from there. Run pnpm commands from the project root.

## Architecture

This is a **Tauri 2 desktop chat application** with a React/TypeScript frontend and Rust backend.

### Frontend (`src/`)

- **React 19 + TypeScript + Vite** — entry point at `main.tsx` → `App.tsx`
- **`core/`** — Chat engine, independent of React:
  - `types.ts` — Rich message model with parts (text, reasoning, tool calls, tool results)
  - `openrouter.ts` — Streaming SSE client for OpenRouter API (`https://openrouter.ai/api/v1/chat/completions`)
  - `loop.ts` — `runChatLoop()` orchestrates multi-turn conversations with automatic tool execution (up to 10 roundtrips). Supports AbortSignal cancellation.
  - `tools.ts` — Tool definitions with JSON Schema and executor functions
- **`hooks/useChat.ts`** — Main React hook managing chat state, conversation CRUD, message serialization (parts ↔ JSON for DB storage), and streaming lifecycle
- **`MessageBubble.tsx`** — Renders completed and streaming messages with collapsible reasoning sections and tool call visualization

### Backend (`src-tauri/`)

- **Rust + Tauri 2** — exposes IPC commands invoked from frontend via `@tauri-apps/api`
- **`db.rs`** — SQLite (rusqlite, bundled) with `Mutex<Connection>` for thread safety. Tables: `conversations`, `messages`
- **`config.rs`** — Loads `config.json` (API key + model). Search order: project root → parent dir → beside executable → `~/.config/thechat/config.json`
- **`lib.rs`** — Tauri command handlers: `get_config`, `create_conversation`, `list_conversations`, `update_conversation_title`, `save_message`, `get_messages`

### Data Flow

1. User sends message → `useChat` saves to SQLite via Tauri IPC → calls `runChatLoop()`
2. `runChatLoop()` streams from OpenRouter, emitting `StreamEvent`s that update React state in real-time
3. If the model returns tool calls, the loop executes tools and continues automatically
4. Final assistant response is saved to SQLite

### Configuration

`config.json` at project root (gitignored):
```json
{
  "api_key": "sk-or-v1-...",
  "model": "google/gemini-3.1-pro-preview"
}
```

## Testing

- Frontend: Vitest with jsdom, globals enabled, setup in `src/test-setup.ts` (clears Tauri mocks after each test)
- Backend: Rust inline `#[cfg(test)]` modules in `db.rs` and `config.rs`
- Tests mock the Tauri IPC layer and OpenRouter API responses

## OpenCode as best practice

For things related to the core chat loop, managing subagents, skills, preventing doom loops, having good system prompts, you can reference OpenCode when it makes sense.

Don't reference OpenCode for everything. Just for things related to managing LLMs where it makes sense. Especially don't reference OpenCode for UI related stuff.

We have OpenCode checked out here /home/bruno/projects/experiment/loop/opencode
