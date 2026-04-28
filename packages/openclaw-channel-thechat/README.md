# @thechat/openclaw-channel

OpenClaw channel plugin that lets OpenClaw operate through a TheChat
workspace as a bot account, using TheChat's signed webhooks for inbound
messages and the TheChat REST API for outbound replies.

This package ships as an external OpenClaw plugin — it is **not** bundled
into OpenClaw core. npm publishing is not required: operators install it
directly from a local checkout with the `--local` (`-l`) flag.

## What it does

| Direction  | Mechanism                                                         |
| ---------- | ----------------------------------------------------------------- |
| Inbound    | Receives `POST /thechat/webhook` from TheChat. HMAC-SHA256 signed. |
| Outbound   | `POST /messages/:conversationId` against TheChat with the bot key. |
| Sessioning | `dm:<id>` / `channel:<id>` target shape, workspace-scoped session keys. |

Two event types are routed:

- `mention` — fired for messages in group channels that `@mention` the bot.
- `direct_message` — fired for every message in a DM with the bot, no
  mention required.

## Install

From a local checkout — no npm publish needed:

```bash
openclaw plugins install -l /path/to/packages/openclaw-channel-thechat
```

OpenClaw discovers the package via its `openclaw.plugin.json` manifest and
loads the default export of `index.ts` (`defineChannelPluginEntry`).

## Configure

In TheChat:

1. Create a bot via `POST /bots/create` with a `webhookUrl` that points at
   your OpenClaw deployment (e.g.
   `https://openclaw.example.com/thechat/webhook`).
2. Add the bot to a workspace (`POST /bots/:botId/workspaces`).

In OpenClaw config (single default account at `cfg.channels.thechat`):

```json5
{
  channels: {
    thechat: {
      baseUrl: "https://thechat.example.com",
      botId: "<bot row id>",
      botUserId: "<bot user id>",
      apiKey: "<bot_... from /bots/create>",
      webhookSecret: "<whsec_... from /bots/create>",
      botName: "OpenClaw",                // optional, used in logs
      allowFrom: ["<thechat user id>"],    // optional allowlist; empty = anyone
      requireMentionInChannels: true,      // default — group channels need @mention
      allowOtherBots: false,               // default — drop other bots' messages
      maxClockSkewSeconds: 300             // default — webhook replay window
    }
  }
}
```

Required fields: `baseUrl`, `botId`, `botUserId`, `apiKey`, `webhookSecret`.
The plugin reads each option at request time, so rotating `webhookSecret`
or `apiKey` requires restarting the OpenClaw process.

## Plugin shape

`index.ts` default-exports `defineChannelPluginEntry({...})` with the real
SDK seam:

- **`plugin`** — `theChatChannelPlugin` (built with `createChatChannelPlugin`)
  exposes the typed `config`, `messaging`, and `outbound.attachedResults.sendText`
  surface OpenClaw expects from a chat-style channel.
- **`registerFull(api)`** — mounts the inbound webhook receiver at
  `POST /thechat/webhook` via `api.registerHttpRoute`. The route reads the
  raw body, calls the pure `handleInbound` helper to verify HMAC, parse,
  and gate, and then hands the dispatched payload back to the OpenClaw
  runtime.

### Inbound dispatch seam

The webhook route reuses `handleInbound` from `./src/inbound.ts`, which is
deliberately kept pure so it can be unit-tested without an OpenClaw
runtime. The verified outcome is then forwarded through whichever inbound
helper the host runtime exposes (`api.dispatchInbound` /
`api.runtime.channel.deliverInbound`). OpenClaw does not currently expose a
fully stable, typed cross-channel inbound dispatch helper for non-bundled
channel plugins — bundled gateway plugins own their own inbound loops — so
that single probe is the narrow gap. When the SDK ships a stable seam,
swapping it is a one-line change in `index.ts`.

## Security

- **HMAC-SHA256** with replay protection: signed content is
  `${timestamp}.${body}`. Timestamps older / newer than the configured
  `maxClockSkewSeconds` (default 300s) are rejected.
- **Constant-time signature comparison** via `crypto.timingSafeEqual`.
- **Bot-loop prevention** is on by default. Messages from the bot itself
  are dropped server-side (in TheChat) and again client-side (here);
  messages from other bots are dropped unless `allowOtherBots` is set.
- **Allowlist** of TheChat user ids — empty means anyone in the
  conversation can talk to the bot.
- **Mention gating**: group channels require an `@bot` mention by default
  so the bot doesn't react to every message in a busy room.

## API surface

```ts
import {
  // Real OpenClaw plugin object — what `defineChannelPluginEntry` wraps.
  theChatChannelPlugin,

  // Pure helpers, version-independent and unit-tested under src/*.test.ts.
  handleInbound,
  sendText,
  shouldDispatch,
  deriveSessionMapping,
  parseTarget,
  computeSignature,
  verifyWebhook,
  validateConfig,
  resolveTheChatAccount,
  CHANNEL_ID,
} from "@thechat/openclaw-channel";
```

The default export is the `defineChannelPluginEntry({...})` value and is
what OpenClaw consumes when the plugin is installed.

## Phase 2: Approvals & Operational Polish

### Approval routing

When OpenClaw needs human approval for a sensitive action (file writes, shell
commands, etc.), the approval router posts a structured approval-request
message directly into the TheChat conversation and waits for a human response.

```ts
import { createApprovalRouter } from "@thechat/openclaw-channel/approvals";

const router = createApprovalRouter(config, { defaultTimeoutMs: 300_000 });

// When a tool needs approval:
const outcome = await router.requestApproval({
  to: "channel:conv-1",
  tool: "write /etc/config.yml",
  description: "Overwrite production config with new TLS settings",
});

if (outcome.decision === "approved") {
  // proceed with tool execution
} else {
  // denied or expired — abort
}
```

The inbound webhook handler automatically intercepts approval responses when
an `approvalRouter` is provided:

```ts
const outcome = handleInbound({
  body,
  headers,
  config,
  approvalRouter: router, // ← messages matching a pending approval are consumed here
});
```

Humans respond in chat with natural language — `approve`, `yes`, `deny`,
`reject`, emojis (`✅` / `❌`), or `lgtm`. When multiple approvals are
pending, the user must reference the request id (e.g. `APR-abc123 approve`).

Features:
- Configurable timeout with auto-expiry (default 5 min)
- Denial with optional feedback (`deny too risky`)
- Bot-message rejection (only humans can approve)
- Conversation-scoped matching
- `dispose()` for clean shutdown

### Doctor / health check

Validate config, connectivity, and credentials in one call:

```ts
import { runDoctorChecks } from "@thechat/openclaw-channel/doctor";

const result = await runDoctorChecks(config);
// result.ok — true when no check returned "fail"
// result.checks — array of { name, status, message, hint? }
```

Checks performed:

| Check | What it validates |
| --- | --- |
| `required_fields` | All required config fields present and non-empty |
| `base_url_format` | baseUrl is a valid http(s) URL |
| `key_formats` | apiKey starts with `bot_`, webhookSecret with `whsec_` |
| `connectivity` | TCP+HTTP roundtrip to the TheChat API |
| `bot_credentials` | Bot API key accepted by `/auth/me` |

Network checks are skipped when prerequisite checks fail (e.g. credentials
check is skipped when connectivity fails). The `fetchImpl` option allows
full unit-testing without a running server.

### Phase 2 follow-ups (not yet implemented)

- **WebSocket transport mode** — Connect to TheChat via WebSocket instead of
  requiring a publicly reachable webhook URL. Needs bot API key → JWT token
  exchange endpoint on the API side.
- **Typing indicators** — Send `typing` events while the bot is processing.
  Requires WebSocket transport (no REST endpoint for typing currently).
- **Threaded replies** — Reply in-thread instead of top-level for busy channels.
- **Rich message formatting** — Markdown, code blocks, structured cards.
- **Multi-account support** — Multiple TheChat workspace accounts per OpenClaw
  instance.
- **Webhook retry / dead-letter queue** — Reliable delivery with backoff.

## Tests

Unit + simulated integration tests:

```bash
pnpm --filter @thechat/openclaw-channel test
```

There is also a simulated channel-plugin integration test that wires
TheChat against an in-process Bun server using the real `handleInbound` /
`sendText` helpers:

```bash
pnpm --filter @thechat/api test:e2e:openclaw-simulated
```

This test does **not** start a real OpenClaw runtime, so it cannot detect
breakage in the OpenClaw plugin entry, the inbound dispatch seam, or the
agent loop.

For the real full round-trip — TheChat ↔ a freshly built OpenClaw ↔
OpenRouter ↔ TheChat — use the orchestrator at
`scripts/openclaw_full_flow_e2e.py`. It is opt-in:

```bash
OPENCLAW_E2E_FULL=1 \
OPENROUTER_API_KEY=sk-or-... \
DATABASE_URL=postgres://... \
pnpm test:e2e:openclaw-full
```

The orchestrator:

1. Clones `https://github.com/openclaw/openclaw.git` (override with
   `OPENCLAW_E2E_OPENCLAW_REPO` / `OPENCLAW_E2E_OPENCLAW_REF`) into a
   reusable repo-local cache (`OPENCLAW_E2E_CACHE_DIR`, default
   `.openclaw-e2e/cache`). It resolves the requested ref as branch/tag/sha
   and fails fast if fetch fails (set `OPENCLAW_E2E_ALLOW_STALE_CACHE=1` to
   allow stale cached code).
2. Runs `pnpm install` + `pnpm build` on first cache use. Per-run scratch
   state/logs default under `.openclaw-e2e/work` (override with
   `OPENCLAW_E2E_WORK_DIR`) rather than `/tmp`.
3. Starts a fresh TheChat API on an ephemeral port (or reuses
   `THECHAT_API_URL` if set).
4. Registers a human, creates a workspace, creates a bot.
5. Writes an isolated OpenClaw config + state dir under
   `OPENCLAW_HOME` / `OPENCLAW_CONFIG_PATH`, points the agent at OpenRouter
   (`agents.defaults.model.primary` defaults to
   `openrouter/qwen/qwen3.6-35b-a3b`; override with
   `OPENCLAW_E2E_MODEL`).
6. Installs *this* package via `openclaw plugins install -l ...`.
7. Starts the OpenClaw gateway on an ephemeral port.
8. PATCHes the bot's webhook URL, adds the bot to the workspace, opens a
   DM, sends a human message.
9. Polls `/messages/:id` for a real bot reply and asserts it is **not**
   the simulated `Echo: ...` shape.

The OpenRouter API key is forwarded only via the OpenClaw child process
environment — it is never logged. `bot_...` API keys, `whsec_...` webhook
secrets, and `sk-or-...` style OpenRouter keys are also redacted from
diagnostic output. Set `OPENCLAW_E2E_KEEP_TEMP=1` to leave the per-run
state dir behind for inspection. For non-secret preflight checks only:
`python3 scripts/openclaw_full_flow_e2e.py --check-only`.
