# Direct Hermes permission proxy

This experimental bot type gives an authorized TheChat desktop a direct Hermes
JSON-RPC connection without exposing the stored Hermes gateway credential. TheChat's
API does not parse, construct, validate, or execute Hermes RPC methods.

## Architecture

```text
TheChat desktop
  1. POST /bots/:botId/hermes-rpc/proxy-ticket { conversationId }
       -> TheChat API authenticates the user
       -> verifies the user owns the Direct Hermes bot
       -> verifies the user and bot are current members of the DM workspace
       -> verifies both are participants in that exact direct conversation
       -> stores a 30-second, single-use capability in Redis

  2. WebSocket /hermes-proxy
       -> dedicated @thechat/hermes-proxy process consumes the capability
       -> decrypts the bot's Hermes credential server-side
       -> opens Hermes /api/ws
       -> forwards text and binary WebSocket frames in both directions

  3. Hermes JSON-RPC
       -> Hermes' JsonRpcGatewayClient runs in the desktop
       -> desktop code selects methods and validates UI-facing results
```

The forwarding path never parses client or upstream frames as JSON, does not contain a
Hermes method allowlist, and does not know what `session.list`, `prompt.submit`, or
any future method means. Its only protocol responsibilities are WebSocket lifecycle,
bounded buffering, token attachment to the upstream URL, safe close reasons, and
byte forwarding. (`JSON.parse` is used only for the proxy's own Redis capability
metadata.)

## Capability and credential boundary

- The API is the authorization authority.
- A capability is 256 random bits, sent in `Sec-WebSocket-Protocol` rather than the
  URL query string.
- Redis stores only a SHA-256 lookup key and the already-encrypted Hermes credential.
- `GETDEL` consumes a capability atomically, including across proxy replicas.
- An unused capability expires after 30 seconds.
- An active tunnel expires after one hour and must reconnect through the API, which
  rechecks current permissions.
- The desktop receives neither the Hermes gateway token nor an authenticated Hermes
  URL.
- The proxy has Redis and encryption-key access but requires no database access.
- Each proxy replica accepts at most 256 tunnels globally, 4 per user, and 8 per bot.
- Client frames, pre-connect buffering, and downstream backpressure are each limited to
  4 MiB.

Connection counters are per replica. Ticket consumption is global across replicas
because Redis performs it atomically.

Authorization is deliberately at the **bot connection** boundary, not per RPC
method. Because one connection can invoke every method exposed by the Hermes gateway,
the current experiment only issues capabilities to the bot owner. Workspace or DM
membership alone is not sufficient. Broader sharing requires an explicit grant and
resource-scoping model rather than silently treating chat access as runtime-wide
authority.

## Hermes client source

`packages/desktop/src/lib/hermes-json-rpc-gateway.ts` is a provenance-marked mirror
of Hermes Agent's canonical browser gateway client at commit
`63279301bcbdc185c1b07b98a9312eb0c862f26d` (upstream source SHA-256
`a18dbcffedae4772d082c38b3c58c2e59e74f2b4919ca99e45ad3492ebc4421b`). It
provides request correlation, timeouts, cancellation, event subscriptions, replay,
heartbeat handling, and structured errors. The upstream MIT notice is retained in
`packages/desktop/src/lib/hermes-json-rpc-gateway.LICENSE`.

The mirror is temporary. Once Hermes publishes this source as a focused package,
TheChat should replace the file with an exact package dependency rather than fork
its protocol client.

## Run locally

`pnpm dev` starts three independently supervised backend processes:

- API on `THECHAT_BACKEND_PORT` (default `3000`)
- Hermes proxy on `THECHAT_HERMES_PROXY_PORT` (default `3001`)
- bot worker

The proxy can also run alone:

```bash
pnpm dev:hermes-proxy
```

Relevant settings:

```dotenv
THECHAT_HERMES_PROXY_HOST=127.0.0.1
THECHAT_HERMES_PROXY_PORT=3001
THECHAT_HERMES_PROXY_URL=ws://localhost:3001/hermes-proxy
THECHAT_HERMES_PROXY_ALLOW_LOOPBACK=true
THECHAT_HERMES_PROXY_ALLOWED_ORIGINS=
```

`THECHAT_HERMES_PROXY_URL` is the browser-visible URL returned by the API. If the
Tauri desktop runs on another host, bind the proxy to an appropriate private
interface and set this URL to an address that desktop can reach. Production should
serve it through TLS as `wss://.../hermes-proxy`.

Upstream access is fail-closed. `THECHAT_HERMES_PROXY_ALLOW_LOOPBACK=true` is
only for local development. Deployed environments must leave it unset and put
each trusted Hermes origin in `THECHAT_HERMES_PROXY_ALLOWED_ORIGINS`, as a
comma-separated list such as `wss://hermes.example.com,wss://other.example.com:9443`.
Matching is exact by scheme, host, and port; arbitrary user-supplied origins are
rejected both when a bot is created and when the proxy opens a tunnel.

The API and proxy must share:

- `REDIS_URL`
- `REDIS_KEY_PREFIX`
- `THECHAT_SECRET_KEY`, or the compatibility fallback `BETTER_AUTH_SECRET`
- `THECHAT_HERMES_PROXY_ALLOWED_ORIGINS` (except for explicit local loopback use)

The API Helm chart deploys the proxy as a distinct Deployment and Service when
`hermesProxy.enabled=true`, and routes `hermesProxy.ingressPath` to that Service.
The chart keeps the experiment disabled by default and requires at least one
`hermesProxy.allowedOrigins` entry when enabled. In Helm deployments both
processes use the existing `BETTER_AUTH_SECRET` `secretKeyRef`; literal
`THECHAT_SECRET_KEY` overrides are rejected. The proxy pod is deliberately not
given `DATABASE_URL`.

## Try it

1. Run a Hermes dashboard/gateway reachable from the proxy process.
2. In TheChat, open **Bots -> Add bot**.
3. Select **Direct Hermes (JSON-RPC)**.
4. Enter a name, Hermes base or `/api/ws` URL, and dashboard session token.
5. Open a direct conversation with the new bot.

6. Choose an existing item from **Sessions** to load its Hermes history, or click
   **New session**.
7. Type a message and click **Send** (Enter sends; Shift+Enter inserts a newline).
8. Watch streamed assistant text and expandable tool activity. Tool cards show
   live arguments and results when Hermes supplies them.
9. Switch between sessions in the sidebar. Each opened session keeps its own
   draft and transient activity; its durable transcript remains in Hermes.

The screen uses the existing desktop Hermes JSON-RPC client throughout. The API
and raw permission proxy still do not understand any RPC methods. No TheChat
message rows, invocation records, or durable session links are created by this
chat surface.

### Connection and history behavior

- `prompt.submit` acknowledges acceptance. The UI stays busy until a terminal
  Hermes event or an authoritative live snapshot confirms the outcome.
- **Stop** requests cancellation from Hermes. An interrupt acknowledgement alone
  is not treated as proof that the turn has finished.
- **Reconnect** obtains a new single-use permission ticket and reattaches to
  Hermes sessions. An ambiguous/disconnected send is never automatically retried.
- **Sync session** refreshes the selected runtime snapshot. A saved session uses
  its durable ID for resume and the returned runtime ID for live controls.
- Approval requests offer **Allow once** and **Deny**. Single-question
  clarifications support choosing an answer or entering free text. Batch or
  multi-select clarifications, sudo, and secret prompts are explicitly marked as
  requiring the Hermes app; they are not silently ignored or accepted.
- Tool outputs in the current connection are transient. On the tested Hermes
  version, saved RPC history includes tool names/arguments but omits full results.
  Such cards explicitly say **Output unavailable in saved history**.
- The session list shows the 200 most recent saved sessions. Hermes' current RPC
  list/history methods do not expose cursor pagination.

### Executable acceptance

See [`../scripts/e2e/direct-hermes-acceptance.md`](../scripts/e2e/direct-hermes-acceptance.md)
for the isolated real-Hermes/raw-proxy test and production-component browser
acceptance. Inference is a clearly labelled deterministic local fixture, while
Hermes, its terminal tool, authentication, the WebSocket relay, and both databases
are real. No external model credential or production user data is used.

## Current limits

- This remains an experimental, bot-owner-only direct connection, not shared
  channel chat. The proxy's existing permission boundaries are unchanged.
- Direct Hermes bots do not receive ordinary TheChat channel messages or mentions.
- Connection settings cannot yet be edited; delete and recreate the bot.
- Active permission revocation is bounded by the one-hour tunnel lifetime rather
  than pushed immediately to already-open sockets.
- Reusable dashboard session tokens are supported. A public Hermes deployment that
  requires fresh `/api/ws-ticket` credentials needs a proxy-side credential provider
  before it can be configured here.
