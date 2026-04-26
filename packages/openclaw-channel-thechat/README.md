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

## Tests

```bash
pnpm --filter @thechat/openclaw-channel test
```
