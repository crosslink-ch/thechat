# Search and navigation

TheChat has one way to find things, for people and agents alike: jump to a
channel, person or Hermes task by name, or search message text. Both work
across every workspace you belong to.

## In the app

| Keys | Opens |
| --- | --- |
| `Ctrl+K` (or `Ctrl+P`, `Cmd` on macOS) | Quick switcher: places, commands and message previews |
| `Ctrl+Shift+F` | Quick switcher, message search only |
| `Ctrl+Shift+P` | Commands only |

The **Search or jump to…** button at the top of the sidebar opens the same
switcher (on a phone, open the navigation first).

- Type a name, loosely: `kda` finds **Koda**, `ribaric` finds **Ribarić**. Exact
  names rank first; recent places and the current workspace break ties.
- With nothing typed, the switcher lists the places you opened most recently,
  from the sidebar, Activity, task list or switcher. Recents are kept on this
  device, per account.
- Narrow with a prefix or the filter buttons (`Tab` cycles them):
  `@` people and bots, `#` channels, `?` messages, `>` commands. A Tasks filter
  finds Hermes tasks by title.
- `Enter` opens the highlighted row. A person you have no DM with gets one.
  Jumping to a bot opens its General conversation; a task opens that task. The
  app switches workspace when needed and focuses the message box.
- Message previews appear under the places, without moving the highlighted
  row. **Search all messages** opens the full results page (`#/search?q=…`),
  which pages through every match. **Only in …** limits a search to the
  conversation on screen.
- Opening a message shows it highlighted among its neighbours at
  `#/message/<id>`: a stable link that also works for old messages. **Open
  conversation** (or **Open task**) continues in the live chat.

Typing never waits on the network for names: the list of places is loaded once
and filtered on the device. Message search is debounced and cancels stale
requests; recent queries are answered from memory.

## Matching rules

- All words must appear, in any order, case-insensitively. `"release notes"`
  keeps a phrase together. `%` and `_` are literal characters.
- At least 2 characters; at most 8 terms and 500 characters.
- Results are newest first. Agent progress updates are never results.
- This is literal substring matching, not semantic search. A trigram index
  (`pg_trgm`) keeps it fast on large histories.

## Who can see what

Every search applies one rule: a message is found only if you take part in its
conversation **and** still belong to its workspace. A removed member loses
their former channels and DMs. DMs are found only by the two participants.
Asking for a conversation you cannot read returns 404, the same as one that
does not exist. Bots and agents get the same rule for their own account: they
see the channels and DMs they are part of, nothing else.

## HTTP API

All endpoints require authentication (bearer token, PAT, bot key or browser
session) and return JSON.

| Endpoint | Returns |
| --- | --- |
| `GET /search/messages?q=…` | `{ results: MessageSearchHit[], nextCursor }` |
| `GET /search/destinations?q=…&kinds=channel,person,task` | `{ destinations }`, best match first |
| `GET /search/directory` | `{ destinations }`: every channel, person and recent task |
| `GET /search/messages/:id/context?before=20&after=20` | The message with its neighbours |

Message search filters: `workspaceId`, `conversationId`, `threadId` (needs
`conversationId`), `senderId`, `after`, `before` (ISO dates), `limit` (1–50,
default 20). Pass `nextCursor` back as `cursor` for older results; pages never
skip or repeat a message, even when many share a timestamp.

A context response is scoped the way the app shows the conversation: a Hermes
task shows only that task, General only untasked messages, a channel or human
DM the whole conversation.

## For agents (MCP)

The `/mcp` endpoint (see [Personal access tokens](personal-access-tokens.md))
offers three read-only tools, annotated `readOnlyHint`. Results are compact
JSON to save tokens.

| Tool | Use |
| --- | --- |
| `find_conversations` | Turn "the releases channel" or "my DM with Simon" into IDs. Tolerates typos. |
| `search_messages` | Find messages by text, optionally within a workspace, conversation, task, sender or time range. |
| `get_message_context` | Read the messages around a hit, in the same scope the app shows. |

A typical agent flow:

```text
find_conversations { query: "releases", kinds: ["channel"] }
  → { destinations: [{ kind: "channel", conversationId: "…", name: "releases", … }] }
search_messages { query: "\"staging password\"", conversationId: "…" }
  → { results: [{ id: "…", senderName: "Bob", snippet: "…", … }], nextCursor: null }
get_message_context { messageId: "…", before: 5, after: 5 }
  → { conversation: {…}, threadId: null, messages: [ … ], hasOlder, hasNewer }
```

Every result carries `conversationId`, `threadId` and the message `id`, so an
agent can go straight on to `get_messages`, `send_message` or a reply in the
right task.

## Operations

Migration `0022_message_search` enables the `pg_trgm` extension and adds two
indexes on `messages`: a GIN trigram index on `content` and a
`(conversation_id, created_at, id)` index for ordered reads. `pg_trgm` is a
trusted extension, but the migration role still needs `CREATE` on the database.
Building the GIN index takes time on a large table and blocks writes to
`messages` while it runs; for a large production history, create the index
`CONCURRENTLY` by hand before deploying (the migration's
`IF NOT EXISTS` then skips it).

Request spans: `search.messages`, `search.directory`, `search.message_context`,
with term counts, scope and result counts as attributes (never the query text).

## Tests

```sh
pnpm --filter @thechat/api test -- src/search/search.test.ts   # API + MCP, real Postgres
pnpm --filter @thechat/client test:unit -- CommandPalette search recent-locations message
pnpm test:e2e:web -- search.spec.ts                            # needs the loopback stack, see web.md
```
