# Shared browser client

The browser edition builds the existing React application, routes and Eden Treaty client. It is not a second UI. The default build remains the native desktop build.

```sh
pnpm dev:web                  # shared Vite frontend, explicit web mode
pnpm build:web                # TypeScript + production browser assets
pnpm build:desktop            # existing native frontend, unchanged default mode
pnpm test:web:build           # build-selection and emitted-module-graph assertions
pnpm --filter @thechat/desktop test:unit --maxWorkers=2
```

Browser output is `packages/desktop/dist-web`; desktop output remains `packages/desktop/dist`. Serve browser assets through HTTPS (or a loopback development origin). Hashing uploads, clipboard and browser notifications require browser-supported secure contexts. Hash routing preserves direct navigation without a second router or server-side route implementation.

## Deployment configuration

Vite web mode reads `.env.web`/the shell environment. Web API routing uses these explicit public values:

- `THECHAT_WEB_API_URL`: absolute API origin, or empty for the browser page's origin (same-origin reverse proxy).
- `THECHAT_WEB_WS_URL`: optional absolute WebSocket URL **including `/ws`**; otherwise derived from the API origin.

The native `THECHAT_BACKEND_URL` setting still controls desktop builds. It intentionally does not silently select the web origin. With separate web/API origins, configure the backend's trusted browser origins and credentialed CORS, and the object-store upload/download CORS, in the isolated deployment. Never copy production credentials into frontend environment variables.

## Authentication and state boundaries

- All product HTTP calls remain Eden Treaty calls. Its centralized browser transport sets `credentials: include` and `X-TheChat-Client: web`, strips any stale bearer header, and fences delayed response bodies against account changes.
- Browser login/register/verify accepts `{user}`; `token` stays `null`. `/auth/me` restores the user. No session token or cached user is written to web storage. Desktop bearer/KV behavior remains available only in native mode.
- Auth mutations are serialized per tab, and across tabs where Web Locks is supported. Storage/BroadcastChannel messages contain only random change signals. Other tabs immediately drop private state and revalidate with the server; visibility restoration also revalidates.
- An authoritative protected HTTP 401 or terminal WebSocket auth failure expires identity, query data, drafts, workspace state, private unread/DM mappings, Hermes transient state and the socket. A workspace-membership 403 does not globally log the user out. Retryable WebSocket auth errors reconnect without dropping identity.
- WebSocket sends `{type:"auth", mode:"cookie"}`. Messages and typing wait for `auth_ok`; the acknowledged user must match the identity captured at connection time before pending messages are flushed.
- Uploads are generation-fenced; account changes abort outstanding composer uploads, clear previews/drafts and do not cancel an old account's reservation with a new account's cookie.

## Platform boundary

Vite resolves `#platform-shell` to desktop or browser lifecycle/components at build time. The emitted browser module graph excludes the legacy local tool runner, provider OAuth, MCP initialization and updater. Preferences use the explicit, allowlisted UI preference adapter (`ui_font_size` and account-scoped `active_workspace_id`), never a generic fake Tauri invoke.

Browser attachments keep the existing presigned upload/download path. Clipboard uses the existing browser API. Browser notifications can be enabled by an explicit Settings action and run only while the page is open; no background push/service worker is registered. No offline authentication cache is provided.

The frontend unit/build checks do not substitute for real cookie-backend, browser-engine, mobile-geometry and two-account end-to-end acceptance. See [web setup and verification](web.md) for the integrated runtime contract and `pnpm test:e2e:web`.
