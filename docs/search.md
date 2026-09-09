# Global search and quick navigation

Open Search with **Ctrl+K** (Ctrl+P is an alias) or the visible Search button.
The same shared UI runs in the browser and desktop frontend.

| Input | Destination |
| --- | --- |
| `Koda` | Matching DMs, channels, and task titles across your workspaces |
| `@Koda` | DMs only |
| `#general` | Channels only |
| `?release notes` | Message contents |
| `>Settings` | Commands; Ctrl+Shift+P starts here |

The mode/filter buttons are alternatives to prefixes. Arrow keys select,
Enter opens, and Escape closes and restores focus. Opening a DM goes to
General; selecting a task goes to that exact thread. Workspace labels
make duplicate names distinguishable. Opening a result switches workspace
before navigating and fails visibly if access is no longer available.

## Results and history

Jump searches names, not message contents. Exact and prefix name matches
rank ahead of fuzzy matches. Empty input combines recent activity with your
recent quick-switcher jumps. Local jump history stores only destination IDs, is scoped to account/server,
and can only reorder results authorized by the current server response.

Messages mode shows short previews. **View all results** opens a paginated
results page with workspace, conversation, task, author, and date context.
Opening a message uses a bounded, highlighted history snapshot, including
old messages outside the normal live chat cache. **Back to latest** returns
to the same conversation/task and the composer. The snapshot is explicitly
not live chat; only visible messages are acknowledged as read.

This searches shared TheChat conversations and task threads. It does not
search private local-agent files, hidden model/tool traces, or external
Hermes memory. Semantic search and `in:` / `from:` filters are not part of
this first version.

Message matching is case-insensitive literal substring search. SQL/LIKE
wildcards in a query are treated literally. This version does not infer
synonyms or silently interpret filter-looking text.
Each query has a 10,000-result safety limit. If more matches remain, the UI
asks you to refine the query rather than offering a page the API cannot serve.

## Access and implementation

The API derives access from current workspace membership and conversation
participation. A workspace ranking hint never grants access. Ambiguous
legacy DMs with extra participants are excluded rather than repaired by a
search request. Search endpoints are human-only and accept browser-cookie
and ordinary human bearer authentication. Results contain bounded text
snippets, never executable highlighted HTML or private message parts.

Endpoints: `GET /search/jump`, `GET /search/messages`, and
`GET /search/messages/:messageId/context`. Their schemas and limits live in
`packages/api/src/search/index.ts`; shared DTOs live in `@thechat/shared`.
Frontend requests use the existing Eden Treaty client and auth boundary.

Migration `0016_global_search` enables PostgreSQL `pg_trgm` and creates a
GIN index on lowercased message contents plus a message-context ordering
index. The migration role needs permission to create the extension/indexes.
Plan index-build time and write-lock impact before applying to a large live
history; feature development and tests do not apply anything to production.

## Verification

Use a disposable Postgres/Redis instance and the ordinary development env.
Do not aim the browser suite at production: it creates synthetic accounts,
workspaces, bots, tasks, and messages through supported APIs.

```sh
pnpm db:migrate
pnpm build:web
pnpm test:web:build
pnpm build:desktop
pnpm test:api
pnpm --filter @thechat/desktop exec vitest run --exclude '**/*.integration.test.ts' --maxWorkers=2
pnpm test:e2e:web search.spec.ts search-channel-tasks.spec.ts
```

The browser suite uses `THECHAT_WEB_E2E_URL` and
`THECHAT_WEB_E2E_API_URL` as documented in `docs/web.md`. It covers
cross-workspace keyboard/touch navigation, task versus General routing,
message pagination, an old-message deep link with reload and return to live
chat, channel-task history/send/draft isolation, and cookie-authenticated private-DM denial. API tests additionally
exercise membership revocation, malformed queries, and pagination bounds.
