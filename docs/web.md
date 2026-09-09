# Browser edition

The browser and Tauri applications share the same React routes and components.
The browser build replaces native platform integrations; it does not run local
agent tools, provider OAuth, local MCP, or the desktop updater. Phone layouts are
part of the initial browser feature, not a separate UI implementation.

## Build and run

Use the repository's pinned pnpm version and Bun. Rust is not required for the
browser bundle.

```sh
pnpm install --frozen-lockfile
pnpm build:web
# Static output: packages/desktop/dist-web

# Development frontend, with API and worker running separately:
pnpm dev:web
```

Configure these values in the repository-root development environment or build
pipeline. Do not put production secrets into frontend-prefixed build variables.

| Variable | Purpose |
| --- | --- |
| `THECHAT_WEB_API_URL` | Browser-reachable HTTP API base URL. Empty means the page's own origin. |
| `THECHAT_WEB_WS_URL` | Optional complete WebSocket URL, including `/ws`. Empty derives it from the web API URL. |
| `BETTER_AUTH_URL` | API's explicitly configured public origin, used to select secure cookie behavior. |
| `THECHAT_WEB_ORIGINS` | Comma-separated exact allowed browser origins, with scheme and port. No wildcard. |
| `THECHAT_WEB_ALLOW_INSECURE_LOOPBACK` | Explicit development-only opt-in for HTTP on loopback. Never enables insecure production cookies. |

For a loopback-only development frontend and API:

```dotenv
THECHAT_BACKEND_HOST=127.0.0.1
THECHAT_BACKEND_PORT=3000
THECHAT_BACKEND_URL=http://127.0.0.1:3000
BETTER_AUTH_URL=http://127.0.0.1:3000
THECHAT_WEB_API_URL=http://127.0.0.1:3000
THECHAT_WEB_WS_URL=ws://127.0.0.1:3000/ws
THECHAT_WEB_ORIGINS=http://127.0.0.1:1420
THECHAT_WEB_ALLOW_INSECURE_LOOPBACK=true
```

Open **http://127.0.0.1:1420**, not a different hostname. Configure the ordinary
Postgres, Redis, Better Auth secret and optional mail/object-store settings as
for the existing API. Run migrations before starting the API and async worker.
Keep development services on a disposable development machine, not production.

For HTTPS, explicitly configure HTTPS API and browser origins and use WSS. A
same-origin reverse proxy is preferred. Forward the original browser Origin
header and WebSocket upgrade, but never use forwarded Host as an authentication
allowlist. A static file host alone cannot serve API/WebSocket requests; supply a
reachable API URL or proxy those routes to the existing backend. The hash router
preserves direct conversation links without a server-side rendering framework.

## Session and compatibility boundary

Browser requests use Eden Treaty with credentials included and
`X-TheChat-Client: web`. Successful browser login/registration/verification
returns user metadata, not an access token. Browser credentials live only in a
host-only HttpOnly cookie, with Secure and SameSite=Lax on HTTPS. No reusable
bearer token is written to localStorage or sessionStorage.

Native desktop requests keep the existing bearer-token API and native credential
storage. Bot keys and personal access tokens do not become browser cookies.
Cookie-authenticated WebSockets authenticate using the original upgrade request
and an explicit cookie-mode auth frame. Existing bearer frames remain supported.
The configured native Tauri development origin on loopback port 1420 is admitted
only outside production mode. Its markerless requests remain bearer-only.
Credentialed web and native CORS both allow the existing `traceparent` and
`tracestate` propagation headers.

Browser-origin/CSRF policy applies before state changes. Cross-tab session changes
invalidate private caches and connections; authoritative expiry is separate from
retryable transport/auth-service outages. Native tools and updater startup stay
out of the browser startup path.

## Attachments

The API's CORS policy and the attachment bucket's CORS policy are independent.
The object store must allow the exact browser origin for presigned PUT/GET/HEAD
and the checksum/content headers used by the existing attachment protocol.
Enable object versioning and run the async worker for file validation/promotion.
Do not make the bucket public.

For an isolated private proxy, `ATTACHMENT_S3_ENDPOINT` can remain an internal
loopback address and `ATTACHMENT_S3_PUBLIC_ENDPOINT` can identify the
browser-reachable HTTPS S3 origin. The latter is used while signing URLs; server
and worker I/O remains internal. Never rewrite a signed URL after signing.
Leave it empty for ordinary AWS S3. A proxy sharing the API hostname must strip
application cookies before forwarding requests to object storage.

No production origin, DNS record or bucket policy is changed merely by building
this frontend. Review and apply any production infrastructure changes separately.

## Verification

```sh
pnpm test:web:build
pnpm build:web
pnpm build:desktop
pnpm test:api
pnpm --filter @thechat/desktop exec vitest run --exclude '**/*.integration.test.ts' --maxWorkers=2
pnpm exec playwright install chromium webkit
pnpm test:e2e:web
```

The browser E2E suite requires a running isolated API, worker, compiled frontend,
Postgres/Redis and versioned S3-compatible test bucket. It creates synthetic
`example.invalid` accounts through supported APIs. It rejects non-loopback test
URLs so it cannot accidentally be aimed at production. Configure
`THECHAT_WEB_E2E_URL` and `THECHAT_WEB_E2E_API_URL` for your loopback listeners;
defaults are `http://127.0.0.1:1420` and `http://127.0.0.1:13300`.
For Secure-cookie acceptance, use HTTPS loopback proxies and matching public API
configuration. Playwright accepts the disposable test certificate only in its
isolated browser context. It does not alter the browser's normal trust store.

`THECHAT_WEB_E2E_ARTIFACTS` overrides the default artifact directory
`~/.cache/thechat/web-e2e`. HTTP traces containing credential material are not
recorded. Test failures report statuses/booleans rather than secret values.

The suite uses actual browser login and server-backed conversation state, not a
Tauri mock or injected user store. Device profiles and short viewport probes are
emulation, not proof of a physical phone's on-screen keyboard. Complete a real
phone playtest before production rollout. Offline storage, installable PWA and
background web push are outside this initial scope.
