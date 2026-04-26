# @thechat/openclaw-channel

OpenClaw channel plugin that lets OpenClaw operate through a TheChat
workspace as a bot account, using TheChat's signed webhooks for inbound
messages and the TheChat REST API for outbound replies.

This package ships as an external OpenClaw plugin — it is **not** bundled
into OpenClaw core. Operators install it via
`openclaw plugins install @thechat/openclaw-channel` once it is published.

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

## Setup

1. In TheChat, create a bot via `POST /bots/create` with a `webhookUrl`
   that points at your OpenClaw deployment (e.g.
   `https://openclaw.example.com/thechat/webhook`).
2. Add the bot to a workspace (`POST /bots/:botId/workspaces`).
3. Configure OpenClaw:

   ```json5
   {
     channels: {
       thechat: {
         baseUrl: "https://thechat.example.com",
         botId: "<bot row id>",
         botUserId: "<bot user id>",
         apiKey: "<bot_... from /bots/create>",
         webhookSecret: "<whsec_... from /bots/create>",
         allowFrom: ["<thechat user id>"], // optional allowlist
         requireMentionInChannels: true,    // default
         allowOtherBots: false              // default — loop prevention
       }
     }
   }
   ```

The plugin reads each option at request time, so rotating `webhookSecret`
or `apiKey` requires restarting the OpenClaw process (matches the rest of
the channel plugins).

## Security

- **HMAC-SHA256** with replay protection: the signed content is
  `${timestamp}.${body}`, and timestamps older / newer than the configured
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
  handleInbound,
  sendText,
  shouldDispatch,
  deriveSessionMapping,
  parseTarget,
  computeSignature,
  verifyWebhook,
  validateConfig,
  installTheChatChannel,
  CHANNEL_ID,
} from "@thechat/openclaw-channel";
```

Each helper is unit-tested under `src/*.test.ts`.

## Remaining seam

The default export wires inbound + outbound via a thin
`installTheChatChannel(api, config)` adapter that uses the OpenClaw plugin
runtime API loosely (`api.registerHttpRoute`, `api.registerOutboundSend`,
`api.dispatchInbound`). The exact names of those hooks vary across
OpenClaw beta releases; consumers building against a pinned OpenClaw
version should swap the adapter for a tight `defineChannelPluginEntry` /
`createChatChannelPlugin` wiring (see
[OpenClaw channel plugin docs](https://docs.openclaw.dev/plugins/sdk-channel-plugins)).

The pure helpers (`handleInbound`, `sendText`, `shouldDispatch`,
`deriveSessionMapping`, `verifyWebhook`) are version-independent and can
be reused as-is.

## Tests

```bash
pnpm --filter @thechat/openclaw-channel test
```
