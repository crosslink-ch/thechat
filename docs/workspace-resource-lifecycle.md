# Workspace resource lifecycle and full-lifetime budgets

This is the integrated contract for ordered migrations **0017 → 0018 → 0019**. Use [database-tenancy.md](database-tenancy.md) for the coordinated deployment, role and rollback gates. No production database, bucket or external Hermes deployment was changed during development.

## Ownership, deletion and retention

- Workspace-bound conversations include direct DMs. Membership and live bot installations govern their data. Personal/unscoped DMs retain participant authority and uploader safeguards.
- A member may delete their own attachment. Bot deletion/download also intersects global attachment safety and installation attachment permissions. Channel deletion is owner/admin-only and refuses active bot runs.
- File deletion preserves canonical metadata/message links as `deleting`/`deleted` tombstones. Historical responses show the unavailable state; content authorization refuses deletion or elapsed retention immediately, before a background sweep.
- Channel/workspace cascades persist **exact object key and version** cleanup receipts before losing canonical coordinates. `attachment_object_cleanup` deliberately has no canonical FK. Success acknowledges one version; failed versions remain pending and are independently retried. No unversioned clean deletion is allowed.
- Clean-copy versions are recorded before integrity checks/promotion. Losing copies are requested for cleanup; abandoned unbound receipts are recovered after ten minutes. Versions pinned by ready/attached canonical rows are not swept as orphans.
- A crash between an object store returning a copy version and PostgreSQL recording it remains an external-system atomicity gap. Inventory/reconcile versions before retiring old storage. This is not distributed atomic commit.

`ATTACHMENT_RETAINED_TTL_SECONDS=0` or unset means persistent retained content. Positive integer seconds `1..315360000` configure **new reservations** and are snapshotted into `retention_seconds`; binding derives `retained_until` from `attached_at`. Existing content is backfilled to persistent retention. An environment change is not a retrospective policy change. Unattached expiry remains separately controlled by `ATTACHMENT_UNATTACHED_TTL_SECONDS`.

The CloudFormation source no longer expires clean current **or noncurrent** versions. Canonical coordinates can pin a noncurrent version. `CleanObjectRetentionDays` remains a deprecated, unused compatibility parameter. Quarantine expiration and multipart/delete-marker cleanup remain. Applying this source is a **separate approved storage change**: verify effective live rules before activating persistent retention. Application deployment alone does not change a bucket.

Uploads without a verified version coordinate do not cause concealed-key probes or invented version IDs. Their capacity remains charged through the signed capability expiry; quarantine lifecycle is the backstop for unverified/late uploads. They are not retained clean content.

## Limits and accounting

| Setting | Default | Meaning per workspace |
|---|---:|---|
| `WORKSPACE_RETAINED_BYTES_LIMIT` | 10737418240 | Retained bytes, draft reservations and pending physical deletion |
| `WORKSPACE_PENDING_VALIDATION_LIMIT` | 32 | Pending plus running validation jobs |
| `WORKSPACE_PENDING_BOT_LIMIT` | 32 | Pending plus running bot jobs |
| `WORKSPACE_CONCURRENT_VALIDATION_LIMIT` | 1 | Live validation leases |
| `WORKSPACE_CONCURRENT_BOT_LIMIT` | 2 | Live bot leases |
| `WORKSPACE_WORK_LEASE_SECONDS` | 120 | Fenced execution lease interval |

The first reservation/admission persists defaults into `workspace_resource_limits`. Environment changes do not override an existing row. Operators apply reviewed tenant overrides transactionally. Lowering a limit below usage blocks further admission; it never deletes content. No public API/MCP operation lets a client set limits or choose a tenant independently of the canonical conversation/invocation.

`workspace_attachment_charges` survives attachment/channel removal. Charges release only after exact-version cleanup and signed upload-capability expiry. SQL `sum(bigint)::text` and JavaScript `BigInt` avoid int32 overflow and IEEE rounding. Per-file and per-uploader/conversation limits remain additional intersections.

Admission and execution are different transitions. The pending `(workspace_id,kind,idempotency_key)` record is committed with the job/outbox. Claims use persisted limits, FIFO ordering within workspace/kind and unique epoch tokens. A capacity refusal durably delays the actual BullMQ job without consuming failed execution attempts; it re-drives after capacity becomes available, rather than waiting in an unbounded process-local queue. FIFO/concurrency blocking pauses the Hermes missing-consumer deadline. Once earlier work settles, its durable settlement timestamp grants a fresh bounded dispatch window; admissible work with no consumer still expires and releases the pending ledger. Tenant A's pending/concurrency limits do not consume tenant B's limits. This is bounded per-workspace scheduling, not a global throughput or hard CPU-isolation guarantee.

## Actual bot execution paths

The integration is wired in `services/bot-runtime.ts`, not merely exported as an unused helper.

### Synchronous HTTP webhook

`handleQueuedBotInvocation` admits/claims durable bot work and wraps the **whole actual HTTP operation** with `withWorkspaceWorkBudget`. The wrapper renews its live epoch and passes an abort signal. Final outbound admission locks and rechecks canonical invocation, conversation/participant membership, installation/channel scope, endpoint URL/revision and attachment safety. The database signer also refuses a missing or expired workspace epoch.

Locks cover `fetch()` initiation, not the network response. Redirects are refused and the request timeout is bounded. Revocation committed before admission produces no external call. A refused final dispatch terminalizes both the canonical invocation and its ledger as cancelled, not completed. An already-initiated request cannot be recalled by a later revocation. Canonical success/failure/cancellation and cascade triggers settle capacity; stale epochs cannot publish or reopen completed work.

### Asynchronous Hermes polling/webhook

Polling claims and Hermes webhook events include the **actual opaque `workToken`** assigned by PostgreSQL-backed admission. Receiving/acknowledging a webhook or a polling delivery is not terminal completion. Its workspace slot remains occupied for the remote run.

A compatible adapter must:

1. Keep the received token bound to this immutable invocation; do not invent, replace or reuse it.
2. Echo it on progress, typing, messages and completed/silent/failed/cancelled callbacks for workspace runs.
3. Heartbeat during long tools, model calls and human-interaction waits, comfortably before the last acknowledged deadline:

   ```http
   POST /hermes-platform/invocations/{invocationId}/heartbeat
   Authorization: Bearer <this bot credential>
   Content-Type: application/json

   {"workToken":"<token actually received in the event>"}
   ```

   Success returns `{ "ok": true, "leaseExpiresAt": "<database deadline in ISO UTC>" }`. A personal/unscoped run has no workspace lease and returns a null deadline. This endpoint renews only an existing live epoch; it writes no chat message, progress event or typing notification.
4. Stop/cancel local execution when authority is rejected or its last acknowledged lease expires. Network failures are not permission to continue indefinitely. A 404/403/409 callback or heartbeat must not become a new claim or an automatic retry of external side effects.
5. Send the terminal callback while its epoch is live. The canonical transition and capacity release share a transaction.

Callbacks revalidate installation revision and live authority. Existing authorized conversation participants may answer non-secret approval/clarify prompts; SQL signing preserves that service permission without admitting arbitrary non-requester payload types. Vault-unlock responses remain bound to the original requester and encrypted context. Missing, forged, expired and terminal epochs fail before canonical writes. Progress persistence races are rechecked before publication and stale transient state is cleared. A global bot owner can withdraw only its own bot through narrow authenticated RPCs without acquiring customer content/roster authority; this cancels canonical work, revokes pending outbox targets, removes the installation/membership and persists the same durable removal-notification contract. Customer messages remain.

**Only internal validation work is retryable after lease expiry. External bot epochs are not replayed.** Maintenance rechecks invocation/ledger locks, terminalizes expired remote work and frees its fenced capacity. It does not pretend an uncertain remote side effect did not happen. SQL canonical terminal/cascade settlement also prevents stranded work. Migration 0019 cancels uncertain legacy active work; recorded silent completion is normalized to completed while preserving response and recorded completion time.

The remote adapter protocol is an activation prerequisite. No external Hermes runtime was modified or customer runtime provisioned in this task. Old adapters that drop `workToken` or do not renew must not be enabled against this workspace protocol. The native contract was exercised with real loopback HTTP and authenticated callbacks; that is not proof that every deployed external adapter is compatible.

## Hard limits of logical control

A database lease fences authority and bounds cooperative scheduling; it cannot physically stop an uncooperative remote process, recall a issued HTTP request, revoke an already-issued object-store URL or erase another system's side effects. Signed downloads remain capabilities until their configured expiry. Use separate bot identities, credentials, runtime instances, tool/data stores and sessions for unrelated customer trust boundaries. Shared sessions, persona state, memory, filesystem and upstream provider credentials are not isolated by workspace rows.

## Cutover, recovery and evidence

Use the single coordinated sequence in [database-tenancy.md](database-tenancy.md). Preserve receipts, charges, canonical rows, old queue evidence and object inventories across rollback. Never restore automatic clean expiration, drop cleanup receipts or replay uncertain bot work as an application-only rollback.

Monitor pending cleanup age/failures, work by workspace/kind, active/expired leases, over-budget tenants and unbound receipts. Do not purge these records as ordinary log retention.

Relevant executable gates use real restricted actor/maintenance roles:

- `attachments/attachments.integration.test.ts`: deletion/tombstones, retention, quota, receipts and copy/deletion races.
- `attachments/download-installation.integration.test.ts`: grant/global-safety/deletion signing races and signer-failure rollback.
- `services/workspace-resource-budgets.integration.test.ts`: independent Bun worker processes, shared leases, fairness and stale-token fencing.
- `services/bot-work-lifetime.integration.test.ts`: actual HTTP lifetime/renewal, remote saturation with independent tenant progress, actual event-token delivery, signer expiry, callbacks/cancellation and recovery without redispatch.
- `bots/bots.test.ts`: composed authenticated heartbeat and canonical callbacks, including no extra message/progress side effects.
- `db/combined-tenancy.integration.test.ts`: consent/withdrawal without customer visibility, installation content RLS and narrow role grants.
- `db/migration-preflight.integration.test.ts`: pristine pre-0017 upgrade, fail-closed diagnostic/explicit repair, preserved data, legacy installation/charges and terminal migration behavior.

Development artifacts/logs live outside Git under `/workspace/thechat-artifacts/combined/`. In-memory object-store fixtures and any local S3-compatible emulator are labelled separately from actual AWS/provider validation. Real cloud and external-runtime canaries remain separately authorized deployment gates.
