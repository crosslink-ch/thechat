# Native Hermes Runtime Inside TheChat

## Correction

TheChat should be a platform for many bots, not a Hermes-shaped application.
Hermes is one bot runtime with unusually rich needs: sessions, tool progress,
cron delivery, approvals, background notifications, and proactive messages.

The right product model is:

- TheChat keeps **conversations**, **channels**, **threads**, **DMs**, and
  **bots** as the primary app concepts.
- Hermes-specific UI appears only where a Hermes bot is active: a Hermes DM,
  a Hermes mention/run in a channel, or a Hermes bot card in a thread.
- Hermes internal sessions are not TheChat's user-facing sessions.
- TheChat supplies Hermes with stable conversation handles so Hermes can keep
  continuity, reset internally, and still deliver back to the right place.

My earlier "lane" proposal was too Hermes-centric. The useful part was the idea
of a stable delivery target. That should be hidden infrastructure, not a global
app primitive.

## Naming

Avoid calling the TheChat-side object a "Hermes session" in the primary UI.
Hermes already manages sessions internally and may rotate them because of:

- inactivity reset
- daily reset
- manual reset
- context compression
- stuck-run recovery

The user-facing model should be a continuous TheChat conversation with visible
**context boundaries**. Internally, TheChat still needs a stable **Hermes
continuity handle**.

Suggested names:

- UI: conversation, thread, DM, context, context boundary
- API/internal: `HermesContinuityHandle`
- Diagnostics only: Hermes internal `session_id`

## Hermes Continuity Handle

A continuity handle is the stable TheChat address Hermes sees as `chat_id`.
It is not a selectable UI object. It identifies "where Hermes should remember
and deliver for this bot in this TheChat scope."

```ts
type HermesScope = "dm" | "channel" | "thread" | "private_channel";

interface HermesContinuityHandle {
  id: string;
  botId: string;
  workspaceId: string | null;
  conversationId: string;
  threadId: string | null;
  scope: HermesScope;
  participantUserId: string | null;
  externalChatId: string;
  createdAt: string;
  updatedAt: string;
}
```

Example `externalChatId`:

```text
thechat:workspace:<workspaceId>:conversation:<conversationId>:thread:<threadId|none>:scope:<scope>:bot:<botId>:participant:<userId|shared>
```

This handle maps cleanly onto Hermes' `SessionSource.chat_id`, but does not
pretend to be Hermes' internal `session_id`.

## Mapping to Hermes Sessions

Hermes currently builds a session key from `SessionSource`. For a native
TheChat platform, TheChat should send enough source metadata to make the
desired memory scope explicit.

Recommended event shape:

```ts
interface HermesNativeEvent {
  invocationId: string;
  messageId: string;
  text: string;
  bot: {
    id: string;
    name: string;
  };
  source: {
    platform: "thechat";
    chatId: string;              // continuity.externalChatId
    chatName: string;
    chatType: "dm" | "channel" | "thread";
    workspaceId: string | null;
    conversationId: string;
    threadId: string | null;
    senderUserId: string;
    senderName: string;
  };
  memoryScope: {
    kind: "shared" | "per_user";
    continuityHandleId: string;
  };
  capabilities: {
    progressEvents: true;
    approvals: true;
    artifacts: true;
    sessionBoundaries: true;
    proactiveMessages: true;
  };
}
```

Hermes should eventually support explicit platform-provided session scope
rather than forcing TheChat through Telegram-era defaults like
`group_sessions_per_user`. Until that exists, TheChat can make `chatId`
include bot/scope/participant information so the generated Hermes session key
has the intended isolation.

## UX Rules

### 1. TheChat remains generic

Channels are normal TheChat channels. They can contain people, Hermes bots, and
non-Hermes bots. A Hermes run is a rich bot event inside the channel, not a
mode that transforms the whole channel.

### 2. Hermes DMs feel like a native Hermes platform

A DM with a Hermes bot can show a Hermes runtime panel because the entire
conversation is with Hermes. That panel can show:

- active run
- tool progress
- cron jobs created from this DM
- context status
- reset/compression boundaries
- approvals
- artifacts

This is scoped to that DM, not global app chrome.

### 3. Channels show per-run Hermes cards

In a channel, Hermes-specific UI should be attached to the Hermes message or
invocation:

- progress card below the active Hermes response
- approval card inline
- artifact cards inline
- compact context boundary only when relevant

The right rail should not become "Hermes Runtime" for the whole channel unless
the user opens the run details drawer.

### 4. Multiple Hermes agents can share a channel

If `@ReleaseHermes` and `@InfraHermes` both participate in `#deploys`, they
must not collide in Hermes memory. The continuity handle must include `botId`.

Bot-to-bot conversation should be policy-controlled:

- human mentions bot: allowed
- Hermes mentions another bot: allowed only if the workspace permits bot relay
  or the target bot is explicitly addressed
- bot loops: TheChat should enforce depth/rate limits and require explicit
  mentions for continued bot invocation

### 5. "Sessions" should not be primary UX

The current TheChat "Hermes sessions" concept is probably the wrong user-facing
abstraction if it means selectable Hermes session threads. Hermes is designed
as one continuous conversation that may be backed by multiple internal sessions.

Better UX:

- The user sees one DM or one channel thread.
- Reset/compression creates a context divider in the timeline.
- Advanced users can open "Context history" to inspect previous epochs.
- Raw session IDs live in diagnostics.

If users need separate durable workstreams, they should use TheChat-native
separation: another DM, channel, thread, or named conversation. Not Hermes
internal session IDs.

## Cron

Cron jobs should be created from and delivered back to TheChat conversations,
not to user-visible Hermes sessions.

When a cron job is created from a Hermes DM:

```json
{
  "deliver": "origin",
  "origin": {
    "platform": "thechat",
    "chat_id": "<dm-continuity-externalChatId>",
    "conversation_id": "<dmConversationId>",
    "thread_id": null,
    "bot_id": "<hermesBotId>",
    "continuity_handle_id": "<handleId>",
    "created_by_user_id": "<userId>"
  }
}
```

When a cron job is created from a channel mention:

- default target: the channel or thread where it was created
- include the Hermes bot ID in the continuity handle
- render result as a scheduled bot message in that channel/thread
- show job actions inline: run now, pause, edit, open details

Cron result UI should look like a scheduled bot message, not like an ordinary
reply from a live human prompt.

## Proactive Messages

Hermes proactive output should use the same TheChat delivery target model:

```ts
type HermesProactiveKind =
  | "cron"
  | "process"
  | "watch"
  | "delegate"
  | "send_message"
  | "system";

interface HermesProactiveMessage {
  target: {
    conversationId?: string;
    threadId?: string | null;
    continuityHandleId?: string;
    externalChatId?: string;
  };
  botId: string;
  kind: HermesProactiveKind;
  title?: string;
  content: string;
  metadata?: Record<string, unknown>;
}
```

Rules:

- A Hermes run can send proactively to its own conversation/thread.
- Sending elsewhere requires a saved schedule, an explicit user request, or
  workspace/admin permission.
- `deliver=thechat` should use a configured home conversation per Hermes bot,
  not a global app-wide Hermes destination.

## Runtime Events

TheChat should keep generic bot runtime infrastructure and let Hermes populate
the richer fields.

Generic bot message:

- content
- sender bot
- references/attachments
- optional runtime status

Hermes-enhanced runtime:

- invocation progress events
- tool calls
- approvals
- artifacts
- session/context boundaries
- cron metadata
- delivery provenance

The UI can render this generically enough that future bots can use pieces of it
without pretending to be Hermes.

## API Direction

The current `/hermes-platform/*` API can evolve into a Hermes adapter protocol,
but TheChat's internal model should remain bot-agnostic.

TheChat to Hermes:

- claim/deliver invocation events
- include conversation, thread, bot, sender, and continuity handle
- include desired memory scope

Hermes to TheChat:

- publish bot message
- publish progress event
- publish approval request
- publish artifact
- publish context boundary
- publish proactive message

The key is that `chatId` is a stable delivery and continuity handle, not a UI
session object.

## Implementation Changes From Current Direction

1. Stop presenting Hermes sessions as primary selectable UI in the DM.
   Replace with a continuous DM plus a context/history disclosure.
2. Keep `botSessions` or equivalent only as an internal mapping table if needed.
   Rename UI labels away from "session" if they remain visible.
3. Ensure continuity handles include `botId`, conversation/thread, scope, and
   optionally participant user ID.
4. Add explicit shared/per-user memory scope to TheChat Hermes events.
5. In channels, render Hermes progress inline per invocation rather than as a
   channel-wide Hermes panel.
6. In Hermes DMs, allow a richer Hermes runtime side panel because the whole
   conversation is Hermes.
7. Model cron and proactive messages as bot-authored messages with provenance,
   not as messages into a selected Hermes session.
8. Add bot relay controls before enabling Hermes-to-Hermes autonomous channel
   conversations.

## First Implementation Pass

- Removed user-created/selectable Hermes sessions from TheChat.
- Kept TheChat's `botSessions` table as a hidden continuity mapping for bot
  runtime routing.
- Changed Hermes DMs to load continuous conversation history.
- Removed the channel-wide Hermes panel; channels keep inline invocation
  progress.
- Added TheChat/Hermes OpenTelemetry spans for continuity resolution, message
  posting, event handling, and proactive TheChat sends.
