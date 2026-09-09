# Global search API

Human UI endpoints, mounted by `src/index.ts`. All three endpoints use the same
current workspace membership **and** conversation participation query. They do
not depend on the client's loaded workspaces, DMs, tasks, or messages. A DM must
have exactly two participants; ambiguous legacy DMs are omitted, not repaired by
a read. Existing bearer session/PAT and trusted browser-cookie policy applies.
Unauthenticated requests return 401; valid bot identities return 403.

## Jump

`GET /search/jump?q=&kind=all&workspaceId=<optional-hint>&limit=30&offset=0&recentIds=<optional-CSV>`

Returns `{ items: SearchDestination[], hasMore: boolean }`. Shared types also
export `SearchJumpOptions`. Kinds are `all`, `dm`, `channel`, `task`. Destination
IDs are `dm:<conversationId>`, `channel:<conversationId>`, `task:<threadId>`.

- Names: DM counterpart name (including bot counterparts), channel display title
  falling back to its name, task title. `conversationName` is always the parent's
  display name; channel `participantType` is null, including its task results.
- Nonempty text ranking: case-insensitive exact, prefix, substring, then ordered
  character subsequence matching. This is palette-style fuzzy matching, not
  typo/edit-distance matching. A task's parent name can match at a lower rank.
  Within each rank: hinted workspace first, then most recently updated, then
  stable kind/conversation/thread IDs.
- Empty text: supplied visited IDs first in their supplied order, then updated
  time descending and stable IDs. `workspaceId` never filters or authorizes.
- `recentIds` is **only** a ranking hint for empty text, applied to authorized
  destinations before pagination. At most 30 unique `kind:uuid` IDs; maximum
  1,600 ASCII bytes, empty string allowed. Unknown/inaccessible valid IDs are
  ignored. Nonempty text ignores this hint.
- Tasks use the later of their last activity and update timestamps. Conversation
  destinations use the conversation update timestamp.

## Messages

`GET /search/messages?q=<text>&limit=20&offset=0`

Returns `{ items: SearchMessageResult[], hasMore: boolean }` ordered by message
creation timestamp descending, then UUID descending. Matching uses parameterized
PostgreSQL `lower(content) LIKE <escaped-literal-substring>`. Multiple words are
one contiguous phrase, not AND terms; no stemming, query operators, or wildcard
syntax. `%`, `_`, backslashes, quotes, and SQL punctuation are literal. Matching
never searches `parts`, tool output, reasoning, attachment metadata or contents.

`content` is a text-only excerpt of at most 320 UTF-16 code units, positioned
around the first match with ellipses when truncated. It is not an HTML highlight
payload; clients must render it as text. No `parts` or attachments are returned.

## Context

`GET /search/messages/:messageId/context`

Returns `SearchMessageContext`:
`{ conversationId, threadId, messages: ChatMessage[], hasOlder, hasNewer }`.
The window contains the target and up to 20 messages on either side (41 maximum),
in chronological `(created_at, id)` order, within exactly the target conversation
and thread (including the null/unthreaded scope). It is not limited by any
initial client message window. Native DB timestamps are compared without losing
microsecond precision. Missing, unauthorized, departed-workspace, corrupt-thread,
and malformed targets all return the same `404 { error: "Message not found" }`.

Authorization, target selection, and window selection share one SQL statement.
Context uses ordinary public attachment/reaction serializers, with attachment
metadata additionally restricted to attached files in that exact conversation.
Deleted files and corrupt cross-conversation links are suppressed. No internal
message parts or object-store keys are serialized. Ordinary message endpoints'
behavior is unchanged; the attachment helper's extra scope is opt-in.

## Input limits and pagination

- `q`: at most 200 characters before trimming; ASCII controls rejected. Required
  and nonblank for message search; optional/blank for Jump.
- `limit`: decimal integer, 1–50; defaults above. `offset`: 0–10,000.
- Workspace hints: nonempty strings up to 100 characters; IDs are slugs, not UUIDs.
- Unknown parameters, duplicate parameters, invalid kinds/IDs, and malformed
  bounds return `400 { error: "Invalid search query" }`.
- Pagination takes `limit + 1` authorized rows to compute `hasMore`; ordering is
  stable for unchanged data. Offset pages are not snapshot cursors across writes.

## Database migration and test receipts

`0016_global_search.sql` enables PostgreSQL `pg_trgm`, adds a GIN index over
`lower(messages.content)` for literal substring matching, and adds the composite
`(conversation_id, thread_id, created_at, id)` context index. Schema, Drizzle
journal, and generated snapshot are included. The migration role must be allowed
to enable `pg_trgm`; normal deployment migration locking conventions apply.
Very short/no-trigram queries remain semantically literal but may scan more rows.

Real DB integration coverage lives in `search.test.ts`; no DB/auth mocks. Run
from `packages/api` against an isolated migrated test DB:

```sh
bun test --env-file ../../.env --timeout=30000 src/search/search.test.ts
```

Implementation used successive vertical RED→GREEN slices (auth, scope, corrupt
DMs, tasks, ranking, pagination, validation, bot policy, messages, snippets,
context, attachments, indexes, visited hints). Development receipts are under
`/workspace/thechat-search-evidence/api/` on the dedicated devbox.
