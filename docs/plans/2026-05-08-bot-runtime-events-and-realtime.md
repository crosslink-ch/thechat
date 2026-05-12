# Bot Runtime Events, Queues, and Realtime Plan

Status: draft, created 2026-05-08.

This plan captures the recommended direction for making TheChat bot processing
work well for Hermes and future webhook-style bots, while also making websocket
delivery safe when the API runs as multiple Kubernetes pods.

## References

The closest existing implementation reviewed was AzulAI PR 8 at
`/home/bruno/agent-worktrees/azulai-pr8`.

Relevant patterns from that workspace:

- `deployment/pubsub-system-plan.md`: BullMQ + Redis async system with Postgres
  metadata, stable job IDs, idempotent workers, and reconcilers.
- `packages/api/src/async/types.ts`: small `AsyncBus`, `QueueCommand`,
  `DomainEvent`, `AsyncMessage`, and `AsyncJobHandler` interfaces.
- `packages/api/src/async/bullmq.ts`: BullMQ-backed bus that stores event/job
  metadata, queues work, and publishes realtime domain events.
- `packages/api/src/async/worker.ts`: generic worker runtime that dispatches
  typed handlers, updates progress, and marks job state.
- `packages/api/src/realtime/domain-events.ts`: Redis Pub/Sub bridge for
  cross-pod realtime fanout.
- `packages/api/src/managed-hermes/realtime.ts`: per-pod websocket hub that keeps
  only local sockets but reacts to Redis-published domain events.

Current TheChat constraint:

- `packages/api/src/ws/index.ts` stores websocket connections in process-local
  maps.
- `deploy/api/values.yaml` currently keeps autoscaling disabled because
  websockets would break if broadcasts stay process-local.

## Direction

Use Redis for two related but separate concerns:

1. BullMQ-backed durable-ish command processing for bot invocations and other
   async work.
2. Redis Pub/Sub fanout for realtime websocket delivery across API pods.

The API pods should become stateless with respect to realtime delivery. A pod may
hold websocket connections, but no product code should assume the recipient is
connected to the same pod that handled the REST request, websocket send, or bot
worker event.

## Async Processing

Add a small async layer, not direct BullMQ calls throughout product code.

Suggested core interfaces:

```ts
type QueueName = string;

interface AsyncMessage<TPayload = unknown> {
  id: string;
  type: string;
  version: number;
  aggregate: { type: string; id: string };
  actor?: { type: "user" | "bot" | "system" | "worker"; id: string };
  tenant?: { workspaceId?: string; userId?: string };
  correlationId: string;
  causationId?: string;
  idempotencyKey?: string;
  occurredAt: string;
  payload: TPayload;
}

interface QueueCommand<TPayload = unknown> {
  queue: QueueName;
  name: string;
  message: AsyncMessage<TPayload>;
  jobId: string;
  attempts?: number;
  backoff?: { type: "fixed" | "exponential"; delay: number };
}

interface DomainEvent<TPayload = unknown> {
  type: string;
  message: AsyncMessage<TPayload>;
}

interface AsyncBus {
  enqueue<TPayload>(command: QueueCommand<TPayload>): Promise<QueuedJob>;
  publish<TPayload>(event: DomainEvent<TPayload>): Promise<PublishedEvent>;
}
```

The first queues should be small:

```text
thechat:events
thechat:bots
thechat:notifications
thechat:maintenance
```

Product code should use a typed command/event catalog rather than hand-written
strings. For bot invocation, use stable job IDs:

```text
bot:invoke:<triggerMessageId>:<botId>
```

This gives BullMQ dedupe and gives the worker a natural idempotency key.

## Database Metadata

BullMQ is the transport. Postgres should keep user-visible and reconciliation
state.

Generic async metadata:

```sql
async_jobs (
  id text primary key,
  queue_name text not null,
  job_name text not null,
  bullmq_job_id text not null,
  type text not null,
  aggregate_type text not null,
  aggregate_id text not null,
  state text not null,
  progress integer not null default 0,
  attempts integer not null default 0,
  max_attempts integer not null default 5,
  run_after timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  last_error text,
  result jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (queue_name, bullmq_job_id)
);

async_events (
  id text primary key,
  type text not null,
  aggregate_type text not null,
  aggregate_id text not null,
  workspace_id text,
  user_id uuid,
  correlation_id text not null,
  causation_id text,
  payload jsonb not null default '{}',
  created_at timestamptz not null default now()
);

async_processed_messages (
  consumer_name text not null,
  message_id text not null,
  processed_at timestamptz not null default now(),
  primary key (consumer_name, message_id)
);
```

The API will sometimes write Postgres state and then enqueue a Redis job. That
has a small dual-write risk. Accept it for the first implementation, but add
reconcilers for important state transitions. For example, periodically find
human messages with bot mentions that have no corresponding `bot_invocations`
row and recreate the `bot.invoke` job.

## Websocket Adaptation

Replace direct process-local broadcasting with a realtime service:

```ts
interface RealtimeEvent<TPayload = unknown> {
  id: string;
  type: string;
  targets: {
    userIds?: string[];
    conversationId?: string;
    workspaceId?: string;
  };
  payload: TPayload;
  occurredAt: string;
}

interface RealtimeBus {
  publish(event: RealtimeEvent): Promise<void>;
  subscribe(handler: (event: RealtimeEvent) => void | Promise<void>): Promise<void>;
}
```

The websocket module should keep only local socket state:

```text
userSockets: Map<userId, Set<WebSocket>>
socketUsers: Map<WebSocket, user>
```

Every API pod subscribes to the same Redis Pub/Sub channel. When any pod or
worker publishes a realtime event, every API pod receives it and only the pod
that has matching local sockets delivers it.

This removes the need for sticky sessions for correctness. A websocket still
lives on one pod, and the ingress must support websocket upgrade, but a user can
reconnect to any pod and continue working.

Recommended delivery rule:

```text
REST/websocket handler or worker mutates Postgres
-> publish durable domain event if the state matters
-> publish realtime event for active clients
-> every API pod receives realtime event
-> each pod filters against local sockets
```

Redis Pub/Sub is not durable. That is acceptable for live UI updates because
clients already refetch messages and bot invocation state on conversation
load/reconnect.

Use one shared channel at first:

```text
thechat:<env>:realtime
```

The payload carries targets. Per-user channels can be added later if volume makes
the single channel noisy.

## Bot Runtime Tables

Do not create Hermes-only history tables. TheChat already owns canonical chat
history in `messages`. Add generic bot runtime tables that can represent Hermes,
webhook bots, and future bot adapters.

```sql
bot_sessions (
  id uuid primary key,
  bot_id uuid not null references bots(id) on delete cascade,
  workspace_id varchar(100),
  conversation_id uuid references conversations(id) on delete cascade,
  scope text not null, -- direct, conversation, thread, workspace
  external_session_id text,
  title text,
  status text not null default 'active',
  last_message_id uuid references messages(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

bot_invocations (
  id uuid primary key,
  bot_session_id uuid references bot_sessions(id) on delete set null,
  bot_id uuid not null references bots(id) on delete cascade,
  conversation_id uuid not null references conversations(id) on delete cascade,
  trigger_message_id uuid not null references messages(id) on delete cascade,
  response_message_id uuid references messages(id) on delete set null,
  adapter_kind text not null, -- webhook, hermes
  status text not null, -- queued, running, completed, failed, cancelled
  external_run_id text,
  request_json jsonb not null default '{}',
  response_json jsonb not null default '{}',
  error text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (bot_id, trigger_message_id)
);
```

For Hermes:

- `external_session_id` is the Hermes `session_id`.
- `external_run_id` is the Hermes `run_id`.
- `bot_invocations` carries queued/running/completed/failed/cancelled status,
  request/response payloads, errors, and timestamps.

For webhook bots:

- `external_session_id` may be null or a value returned by the webhook bot in a
  future response API.
- `bot_invocations` carries webhook request status, response metadata, errors,
  and timestamps.

## Bot Event Model

Create a bot-neutral incoming event:

```ts
type BotTrigger = "mention" | "direct_message" | "reply" | "command";

interface BotIncomingEvent {
  trigger: BotTrigger;
  message: ChatMessage;
  cleanedContent: string;
  conversation: {
    id: string;
    type: "direct" | "group";
    name: string | null;
    workspaceId: string | null;
  };
  workspace: { id: string; name: string } | null;
  bot: { id: string; userId: string; name: string; kind: BotKind };
  session: {
    id: string;
    scope: "direct" | "conversation" | "thread" | "workspace";
    externalSessionId?: string;
  };
  history: BotContextMessage[];
}

interface BotContextMessage {
  id: string;
  role: "user" | "assistant" | "tool" | "system";
  sender: { id: string; name: string; type: "human" | "bot" };
  content: string;
  parts: MessagePart[] | null;
  createdAt: string;
}
```

Then use adapters:

```ts
interface BotAdapter {
  kind: BotKind;
  handle(event: BotIncomingEvent, context: BotInvocationContext): Promise<void>;
}
```

Initial adapters:

- `WebhookBotAdapter`
- `HermesBotAdapter`

The trigger resolver should be generic:

- DMs can trigger bots without `@mention` when the bot policy allows it.
- Group/channel messages trigger on `@bot-name` by default.
- Reply-to-bot or command triggers can be added without changing adapter logic.

## Conversation History

TheChat should keep using `messages` as canonical visible history. Add a generic
history builder for bot adapters:

```ts
getBotConversationContext({
  botId,
  botUserId,
  conversationId,
  triggerMessageId,
  historyLimit,
  includeOtherBots,
});
```

Role mapping:

- Messages from the target bot become `assistant`.
- Human messages become `user`.
- Other bots are configurable: exclude by default, or include as named context
  text if the bot opts in.
- The current trigger message is not included in `history`; it becomes the
  current input.
- In group conversations, prefix human content with the sender name when sending
  to LLM-style runtimes so the model can distinguish speakers.

For Hermes specifically, the adapter should call `/v1/runs` with:

```json
{
  "input": "<cleaned current message>",
  "session_id": "<externalSessionId>",
  "instructions": "<Hermes default instructions>",
  "conversation_history": [
    { "role": "user", "content": "Alice: earlier message" },
    { "role": "assistant", "content": "previous bot reply" }
  ]
}
```

The stable Hermes session ID is still useful for Hermes-side continuity and
identity, but TheChat should send history explicitly because Hermes `/v1/runs`
does not load prior messages from `session_id` by itself.

For webhook bots, extend the payload in a backward-compatible way:

```ts
interface WebhookPayloadV2 extends WebhookPayload {
  version: "2026-05";
  deliveryId: string;
  trigger: BotTrigger;
  session: { id: string; scope: string };
  history?: {
    messages: BotContextMessage[];
    truncated: boolean;
  };
}
```

History should be opt-in per bot or capped by a conservative default.

## UI Model

The message list should continue rendering from `messages`.

Bot runtime UI should read the generic runtime tables:

- Workspace bots
- Bot sessions
- Session detail
- Invocation detail
- Event/tool/progress timeline

Hermes can enrich this with Gateway health, capabilities, run IDs, and future
Hermes session endpoints, but the UI should not depend on Hermes being the only
bot runtime.

Channel message rendering should eventually support `parts`, not just plain
Markdown `content`, so bot messages can display reasoning/tool/progress blocks
when they are stored as structured message parts.

## Suggested Implementation Phases

1. Add Redis to local compose and Kubernetes values.
2. Add `bullmq` and `ioredis` to the API package.
3. Add `async/*` infrastructure: bus, memory bus, BullMQ bus, worker runtime,
   metadata store, typed command/event catalog.
4. Add Redis-backed realtime bus and update websocket broadcasting to go through
   `RealtimeBus`.
5. Replace direct `broadcastToUser` imports with a `RealtimeNotifier` service.
6. Add worker deployment entrypoint and keep API pods worker-free in production.
7. Add bot runtime tables.
8. Move mention/DM bot handling from fire-and-forget in-process calls into
   `bot.invoke` jobs.
9. Add `BotIncomingEvent`, history builder, and adapter interface.
10. Update Hermes adapter to send `conversation_history`.
11. Extend webhook payloads with optional session/history fields.
12. Add reconcilers for stuck/missing bot invocations.
13. Build bot sessions/invocations UI on top of the generic tables.

## Kubernetes Notes

API deployment:

```text
replicas: 2+
ASYNC_ENABLED=true
ASYNC_WORKER_ENABLED=false
REALTIME_DRIVER=redis
```

Worker deployment:

```text
command: bun packages/api/src/scripts/worker.ts
ASYNC_ENABLED=true
ASYNC_WORKER_ENABLED=true
ASYNC_WORKER_QUEUES=thechat:events,thechat:bots,thechat:notifications
```

Redis should be treated as shared cluster infrastructure, not a sidecar:

- AOF enabled.
- No eviction for queue keys.
- Persistent storage.
- readiness/liveness probes.
- credentials in a Kubernetes Secret.

Once websocket delivery goes through Redis Pub/Sub and clients can resync from
Postgres, API autoscaling can be enabled without requiring sticky sessions for
correctness.
