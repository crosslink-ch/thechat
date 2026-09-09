# Shared browser client

The browser edition builds the existing React application, routes and Eden Treaty client. It is not a second UI. The executable packages are independent: `packages/web` owns browser startup/config and `packages/desktop` owns Tauri startup/config. `packages/client` owns the one shared React application.

```sh
pnpm dev:web                  # independent browser Vite frontend (port 1422)
pnpm build:web                # TypeScript + production browser assets
pnpm build:desktop            # native frontend (port 1420)
pnpm test:web:build           # build-selection and emitted-module-graph assertions
pnpm --filter @thechat/client test:unit
pnpm --filter @thechat/web test:unit
pnpm --filter @thechat/desktop test:unit
```

Browser output is `packages/web/dist`; desktop output remains `packages/desktop/dist`. Serve browser assets through HTTPS (or a loopback development origin). Hashing uploads, clipboard and browser notifications require browser-supported secure contexts. Hash routing preserves direct navigation without a second router or server-side route implementation.

## Deployment configuration

The web package reads `.env.web`/the shell environment. Web API routing uses these explicit public values:

- `THECHAT_WEB_API_URL`: absolute API origin, or empty for the browser page's origin (same-origin reverse proxy).
- `THECHAT_WEB_WS_URL`: optional absolute WebSocket URL **including `/ws`**; otherwise derived from the API origin.

The native `THECHAT_BACKEND_URL` setting still controls desktop builds. It intentionally does not silently select the web origin. With separate web/API origins, configure the backend's trusted browser origins and credentialed CORS, and the object-store upload/download CORS, in the isolated deployment. Never copy production credentials into frontend environment variables.

## Authentication and state boundaries

- All product HTTP calls remain Eden Treaty calls. Its centralized browser transport sets `credentials: include` and `X-TheChat-Client: web`, strips any stale bearer header, and fences delayed response bodies against account changes.
- Browser login/register/verify accepts `{user}`; `token` stays `null`. `/auth/me` restores the user. No session token or cached user is written to web storage. Desktop bearer/KV behavior remains available only in native mode.
- Auth mutations are serialized per tab, and across tabs where Web Locks is supported. Storage/BroadcastChannel messages contain only random change signals. Other tabs immediately drop private state and revalidate with the server; visibility restoration also revalidates.
- An authoritative protected HTTP 401 or terminal WebSocket auth failure expires identity, query data, drafts, workspace state, private unread/DM mappings, Hermes transient state and the socket. A workspace-membership 403 does not globally log the user out. Retryable WebSocket auth errors reconnect without dropping identity.
- Returning to a visible tab preserves its in-memory identity and unsent drafts on a network/503 revalidation failure. This does not introduce an offline identity cache. A real 401 still expires the session.
- WebSocket sends `{type:"auth", mode:"cookie"}`. Messages and typing wait for `auth_ok`; the acknowledged user must match the identity captured at connection time before pending messages are flushed.
- Uploads are generation-fenced; account changes abort outstanding composer uploads, clear previews/drafts and do not cancel an old account's reservation with a new account's cookie.
- Browser downloads are generation-fenced through authorization, body transfer and final handoff. Session reset aborts the transfer; completed operations remove their reset subscription.

## Platform boundary

Each executable Vite config resolves `#platform-shell` and `#platform-services` to its own implementations. The shared package typechecks against its own `platform/contracts.ts` and ambient module declarations, never TS paths to an app. Desktop and web implementations independently satisfy the same contracts. The parsed and emitted browser module graph excludes all Tauri SDK imports as well as the legacy local tool runner, provider OAuth, MCP initialization and updater. Preferences use the explicit, allowlisted UI preference adapter (`ui_font_size` and account-scoped `active_workspace_id`), never a generic fake Tauri invoke.

Browser attachments keep the existing presigned upload/download path. Clipboard uses the existing browser API. Browser notifications can be enabled by an explicit Settings action and run only while the page is open; no background push/service worker is registered. No offline authentication cache is provided.

The frontend unit/build checks do not substitute for real cookie-backend, browser-engine, mobile-geometry and two-account end-to-end acceptance. See [web setup and verification](web.md) for the integrated runtime contract and `pnpm test:e2e:web`.

## Package ownership and tests

- `@thechat/client`: `src/index.tsx` mount, router/routes, common components,
  state/network/auth algorithms, CSS and public assets. Package exports resolve
  the same source files in both consumers; stores and query client are singletons.
- `@thechat/web`: HTML/main, fixed browser services and session synchronization,
  notification permission UI, browser/mobile component harnesses and Vite config.
- `@thechat/desktop`: HTML/main, native services/shell, local tools, provider OAuth,
  MCP, updater, legacy local-agent UI and the unchanged `src-tauri` flavor config.
- `web -> client` and `desktop -> client` are the only application dependencies.
  UI preferences and native credentials are distinct typed storage contracts;
  unsupported browser-native file/local-history capabilities are explicitly null.
- Shared CSS discovers client sources relative to itself. The desktop CSS entry
  adds desktop-only sources so native chrome/legacy dialogs keep their utilities.
  Both builds serve the same `client/public` assets.
- `pnpm test` discovers `client`, `web`, `desktop`, both integration locations and
  entrypoint/compiled graph gates alongside the existing backend/native suites.
  Existing shared tests retain IPC mock coverage using test-only composition in
  `scripts/testing`, outside production client source. No test adapters enter builds.

The graph gate builds both executables and checks shared singleton modules,
no parsed native modules in web, shared CSS and desktop-only Tailwind utilities.
Browser and mobile fixtures live under `packages/web`; compiled native WebDriver
fixtures and Tauri build commands remain under `packages/desktop/e2e`.
