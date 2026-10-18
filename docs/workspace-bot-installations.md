# Workspace bot installation and revocation contract

## Ownership and runtime boundaries

Every conversation with `workspace_id` belongs to that workspace, including direct DMs. Membership loss revokes participation, discovery, message/runtime reads, writes, file access and realtime visibility. Unscoped personal DMs retain participant-based permissions. Existing group channels remain workspace-wide for humans; a bot installation may narrow only that bot's channel scope. This is not a private-channel feature.

Human accounts and bot identities/owners remain global. Installation administration is a different authority: only a current human workspace owner/admin can manage the workspace's grants. A bot key cannot approve or expand an installation even if an erroneous membership row says `admin`.

Installing a bot explicitly consents to use of its shared runtime. Separate chat/session identifiers do **not** isolate runtime files, credentials, process state or memory. Use workspace-dedicated runtime instances and credentials for unrelated customers. TheChat does not provision these instances or claim that session separation is a hard isolation boundary. The install/create UI discloses this tradeoff before the action; MCP descriptions disclose it too.

## Installation state

`bot_workspace_installations` is keyed by `(workspace_id, bot_id)`. It stores enabled state, `all`/`selected` channel scope, attachment grant, shared-runtime consent, approved endpoint URL/revision, approving human attribution and an optimistic grant revision. `bot_installation_channels` is keyed by `(workspace_id, bot_id, conversation_id)` with composite FKs to the installation and a same-workspace conversation. A missing, disabled or unconsented installation denies workspace resource access. Personal unscoped DMs keep their participation rule.

Attachment authority is the intersection of the global `bots.attachment_access` safety ceiling, the current workspace installation attachment grant, selected channel scope and ordinary resource membership. A workspace grant never lifts the global ceiling. The scoped helper `canBotAccessConversationAttachments(executor, conversationId, userId)` supplies this intersection; callers still establish current membership with the shared conversation authorization service.

`bots.endpoint_revision` increments only when the registered URL changes, through either bot self-registration or owner management. The bot may register its new endpoint, but may not silently update workspace approval. Dispatch requires the current URL and revision to match the installation's approved pair. Reapproval is an explicit admin operation. Captured invocations also pin the installation revision; grant changes invalidate captured delivery/claim payloads rather than replaying old scope or attachment authority. Global safety is rechecked when polling is claimed and immediately before outbound dispatch.

### Shared API contract

- `GET /workspaces/:workspaceId/bots/:botId/installation`: current human workspace admin only.
- `PUT /workspaces/:workspaceId/bots/:botId/installation`: same authority; strict input below.
- MCP `get_bot_installation` and `update_bot_installation`: the same shared services/validation/authority, adding workspaceId and botId to the input.

```json
{
  "enabled": true,
  "channelScope": "selected",
  "conversationIds": [],
  "attachmentAccess": false,
  "sharedRuntimeConsent": true,
  "approveEndpoint": true,
  "expectedRevision": 1
}
```

All fields except `approveEndpoint` are required. At most 500 UUID conversation IDs are accepted. Every selected conversation must be in this workspace. Empty selected scope grants no conversations. `approveEndpoint` approves the **current** locked bot endpoint; omission preserves previous approval. A stale expectedRevision returns 409. Bot owner identity outside this workspace is insufficient to administer grants. Existing add/request/approve flows create explicit all-channel installations without granting a bot key installation administration; accepting a request attributes workspace approval to its current human requester, not the global bot owner.

## Atomic lifecycle and durable effects

Workspace/owner/General/participant bootstrap commits in one transaction. Invite creation locks the workspace before checking current human administrator authority. Accept locks the same workspace before consuming the invite and enrolling membership/General participation in the same transaction; current inviter authority is checked again. Pending invitation creation is serialized by this convention. Bot approval also requires the requester to retain current administrator authority.

Services enqueue `workspace.lifecycle.notification` version 1 in the transactional outbox with workspace tenant/aggregate identity and `{ targetUserIds, event }`. Events retain existing client contracts: `member_joined`, `member_role_changed`, `member_removed`, `invite_received`, `bot_workspace_invite_received` and `bot_workspace_invite_resolved`. REST, MCP and internal callers use the same service effects; route-only duplicates have been removed. The post-commit fast path is best effort; failure leaves durable outbox work. Delivery is at-least-once, so invalidations must tolerate retries/duplicates. Transaction rollback exposes neither enrollment nor its queued lifecycle effect.

## Final dispatch authorization

Recipient capture is routing, not permission. Local websocket delivery validates resource access/current bot grant under the same workspace lock used by revocation, held through socket send. Presence snapshots/deltas recompute live human peers sharing a workspace. Pending invitation delivery also checks current inviter/requester authority.

Explicit exceptions are identifier-only invalidations: `member_removed` may reach the removed subject; bot-invite resolution may reach its owner/requester after departure. Resource content is not sent through those exceptions. Unknown resource events fail closed, apart from authentication/error/pong control events.

Webhook dispatch, retries and human approval/encrypted vault relays revalidate invocation status, current bot and initiating human resource authority, installation/channel scope, endpoint revision and attachment safety immediately before `fetch()` initiation. Locks cover this admission, **not** the network response. A removal/cancellation committed before admission causes zero outbound calls. An HTTP request already initiated cannot be recalled by later revocation. Redirects are refused (`redirect: "error"`); outbound requests have an AbortSignal deadline. `BOT_WEBHOOK_TIMEOUT_MS` defaults to 10000 and is capped at 30000; invalid/nonpositive values use the default. Existing tighter relay deadlines remain effective.

Similarly, signed download URLs already issued cannot be recalled; download authorization must be checked before issuance, with a bounded URL TTL. Runtime isolation, object-store retention, RLS enforcement and capacity scheduling are separate concerns, not claims made by this helper.

## Migration and integration

Migration `0018_workspace_bot_installations` adds the tables/index/endpoint revision, then explicitly backfills each existing bot workspace membership to enabled/all-channel/current-endpoint consent with its existing attachment ceiling. This is a reviewed compatibility decision for old administrator-approved memberships, not a runtime absence-is-permission fallback. The backfill has no fabricated historical approving human. Review the membership inventory before applying; for unrelated customers requiring harder isolation, disable/restrict affected installations and provision dedicated runtimes separately. Take a database backup, apply using migration authority, verify membership/grant parity and endpoint approvals, then deploy matching application code. Do not roll back only the application to a membership-only authorization version: that would bypass grants. Prefer forward repair; schema removal requires explicit stopped/drained application and backup restoration planning. No production database or runtime was changed during development.

The isolated migration was tested against a fresh PostgreSQL database and an exact-base upgrade containing synthetic legacy memberships. The combined hardening PR must reconcile this journal/snapshot and equivalent composite conversation index with migrations 0017 and 0019, then repeat fresh/upgrade gates on the combined schema.

Integration entrypoints:

- Restricted DB actor/scope wrappers: existing db abstraction, `lifecycleTransaction`, scoped reads in conversation/messages/workspace/installation services, and `withAuthorizedRealtimeEvent`.
- Attachment/download lane: use scoped `canUserAccessAttachments(executor,userId,conversationId)`/`canBotAccessConversationAttachments` at final file read/upload/bind/download-signing transaction boundaries; legacy global flag alone is not sufficient.
- Capacity lane: canonical invocation enqueue is `getOrCreateInvocation`; claims enter `handleQueuedBotInvocation`, `claimHermesPlatformEvents` and `deliverHermesPlatformWebhookInvocation`. Final outbound admission is centralized in `dispatchCurrentWebhook`. This lane does not invent tenant scheduling guarantees.

Focused tests use real PostgreSQL/service routes, live Bun loopback websockets/webhook servers, and synthetic storage/provider seams only where needed. Evidence and RED/GREEN logs are retained outside Git under the disposable devbox artifact directory; screenshots and credentials are not committed.
