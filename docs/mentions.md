# Mentions

A mention is the person or agent picked in the composer's @ menu, identified
by user ID. The visible `@Name` is only a label.

## Message formats

A message has a `contentFormat`:

| Format | Source of truth | Mentions |
| --- | --- | --- |
| `parts-v1` | `parts`: ordered text and user references | The referenced user IDs |
| `legacy-text` (default, all older rows) | `content` | `@Display Name` matched against current names |

The desktop and web composers send typed messages as `parts-v1`. Sends with
no composer text (attachments only, voice messages, the Hermes stop command)
stay `legacy-text`. Programmatic clients (the REST API, MCP, bots) may send
either. A request carries `parts` or `content`, never both:

```json
{
  "clientMessageId": "client-123",
  "contentFormat": "parts-v1",
  "parts": [
    { "type": "text", "text": "Hi " },
    { "type": "reference", "refType": "user", "refId": "7b4e…" }
  ]
}
```

The same body is accepted by `POST /messages/:conversationId`, the WebSocket
`send_message` event, `POST /hermes-platform/messages` and the MCP
`send_message` tool.

## What the server does

In the send transaction the server:

1. Rejects unknown fields and reference types (only `refType: "user"`).
2. Checks every referenced user is a participant of the conversation and a
   current member of its workspace. One invalid reference rejects the whole
   message, with the same error whatever the reason, and nothing is stored.
3. Stores the parts with a `label` snapshot (the target's name now) and
   `targetType` (`human` or `bot`).
4. Derives `content` from the parts (`Hi @Koda`), trimmed at the edges. It is
   the readable projection for search, notifications, exports and old
   consumers, never a second source.
5. Derives the bot targets from the referenced IDs.

Limits: 500 parts, 50 reference occurrences, 100 000 characters of content.

The idempotency check (`clientMessageId`) compares the parts: the same visible
text pointing at a different user is a conflict (409), not a replay.

## Rollout order

Deploy the API before the web and desktop clients. An API without this change
ignores `parts`, so every text message a new client sends is refused as empty
(400, "Message text or at least one attachment is required"). Rolling the API
back below this change has the same effect while new clients are live.

## Effects

For a `parts-v1` message, every effect comes from the referenced IDs:

- Bot invocation: only the referenced bots. Two bots with the same name are
  told apart; renaming a bot after it was picked does not change the target.
- Push and in-app notifications ("Mentioned you"), and thread following for a
  reply that mentions someone.
- The "mentions you" highlight.

The same target mentioned twice notifies or invokes once. A direct message to
a Hermes bot still invokes it without a mention.

A typed or pasted `@Name` that was not picked from the menu is plain text in a
`parts-v1` message: no notification and no bot run. This differs from
`legacy-text`, where the name match still applies.

## Rendering

Pills of a `parts-v1` message come from its reference parts: the target's
current name when known, the label snapshot otherwise (e.g. a former member).
The message is parsed as one Markdown document, so emphasis or code around a
mention works. Old messages keep the name-matched pills.

## Outbound payloads

Webhook deliveries (`message`) and Hermes platform events carry
`contentFormat: "parts-v1"` and `parts` for structured messages, next to the
readable `content`/`text`. For Hermes, `text` is the prompt with the reference
to the invoked bot removed; line breaks and indentation are kept.

## Composer

`packages/client/src/lib/composer-parts.ts` is the one converter between the
Tiptap document and `parts-v1`. Drafts store the parts, so a restored draft,
a retry and the optimistic message keep their mentions.

The @ menu shows People, then Agents, with prefix matches first. When two
candidates share a name, each shows a short discriminator (the agent kind and
the first characters of the ID). In a DM only its participants are offered.
