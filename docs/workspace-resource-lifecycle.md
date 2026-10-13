# Workspace attachment lifecycle and budgets (migration 0019)

## Contract

- A workspace member may delete only their own attachment (the global bot attachment safety gate still applies). Channel deletion remains owner/admin-only, and still refuses active bot runs. Installation-grant checks are composed by the authentication lane; a global bot attachment toggle is not an installation grant.
- Attached file deletion preserves its canonical metadata/message link as a `deleting` then `deleted` tombstone. Historical message responses explicitly include that status; content authorization rejects unavailable content. Channel deletion removes history, but commits exact key/version cleanup receipts before removing the canonical rows.
- `attachment_object_cleanup` has **no canonical foreign keys**. Retries and the periodic cleanup worker use these receipts even after channel/workspace/attachment removal. Each successful version is acknowledged separately; a failed version remains pending. No unversioned clean delete is permitted.
- The worker records every returned clean copy version before integrity checks/promotion. Failed/lost-race copies are requested for cleanup; abandoned unbound receipts are recovered after ten minutes. Versions still pinned by ready/attached canonical rows are never swept as orphans. A crash between S3 returning a copy version and PostgreSQL acknowledging the receipt remains an external-system atomicity gap: inventory/reconcile those versions before retiring old storage. This is not a claim of distributed atomic commit.

## Retention

`ATTACHMENT_RETAINED_TTL_SECONDS=0` (also unset) means persistent retained content. Positive integer seconds (1..315360000) explicitly configure **new reservations**; the value is snapshotted into `retention_seconds`. Binding starts `retained_until` from `attached_at`. Existing attachments are backfilled to persistent retention, not silently assigned a new deadline. Changing the environment is not a retrospective policy change.

The cleanup worker reconciles elapsed `retained_until` to `deleting`, durable receipts and eventual `deleted`. Download authorization rejects an elapsed deadline even before the next sweep. Unattached reservation expiry remains separately controlled by `ATTACHMENT_UNATTACHED_TTL_SECONDS`.

The production CloudFormation template no longer expires clean current **or noncurrent** versions. Database coordinates can legitimately pin a noncurrent version. `CleanObjectRetentionDays` remains only as a deprecated, unused compatibility parameter so existing stack parameter files do not become invalid. Quarantine one-day expiration and multipart/delete-marker cleanup remain. Never restore noncurrent expiration as an automatic cleanup of copies; use exact-version receipts.

Uncompleted uploads have no verified version coordinate. The worker does not probe concealed S3 keys or fabricate a version. Outstanding signed upload capacity stays charged through its capability expiry; quarantine lifecycle is the bounded backstop for unverified/late uploads. These are not retained clean content.

## Budgets and defaults

| Setting | Default | Effect |
|---|---:|---|
| `WORKSPACE_RETAINED_BYTES_LIMIT` | 10737418240 | 10 GiB of retained attachment content + draft reservations + pending object deletion |
| `WORKSPACE_PENDING_VALIDATION_LIMIT` | 32 | Admitted validation jobs (pending + running) per workspace |
| `WORKSPACE_PENDING_BOT_LIMIT` | 32 | Admitted bot jobs (pending + running) per workspace |
| `WORKSPACE_CONCURRENT_VALIDATION_LIMIT` | 1 | Live DB leases per workspace across all validation workers |
| `WORKSPACE_CONCURRENT_BOT_LIMIT` | 2 | Live DB leases per workspace across all bot workers |
| `WORKSPACE_WORK_LEASE_SECONDS` | 120 | Lease lifetime, renewed every third of the interval |

The first admission/reservation persists explicit defaults into `workspace_resource_limits`. Environment changes do not override an existing workspace limit row. Operators deliberately change that row transactionally to apply reviewed tenant overrides; lowering a limit below existing usage blocks further admission, not deletes content. No public client may write limits or choose a workspace independent of the authoritative conversation/invocation.

`workspace_attachment_charges` survives canonical attachment/channel removal and releases only after exact-version cleanup is complete (and a signed upload capability is no longer valid). PostgreSQL `sum(bigint)::text` plus JavaScript `BigInt` avoids int32 overflow and IEEE rounding. Per-file limits and atomic per-uploader/per-conversation safeguards remain additional intersections, not replacements. Personal/unscoped DMs retain their uploader safeguards; workspace limits do not charge another tenant.

Work admission and execution are separate. Admission locks the persisted workspace limit row and inserts one `(workspace_id, kind, idempotency_key)` record in the same transaction as the job/outbox. Work is FIFO within a tenant and kind, has no in-process unbounded waiter queue, and returns 429 to the bounded event retry path when saturated. Different workspaces have independent pending/concurrency capacity, so a tenant holding a lease cannot hold another tenant's admission lock. This is per-tenant bounded capacity, not a global scheduler throughput guarantee.

Expired leases are reclaimable with a new fencing token. Old tokens cannot settle or renew newer attempts. Cancel/delete releases pending admission atomically. The wrapper renews leases and supplies `signal`, `assertLease` and the fencing `lease`; attachment promotion also includes the live token/expiry in its final SQL mutation predicate. Operations must honor cancellation and recheck immediately before external dispatch/commit. A DB lease is not hard isolation of a remote runtime, and cannot cancel an already-issued remote request by itself.

## Concrete bot integration seam

`packages/api/src/services/workspace-resource-budgets.ts` exports:

```ts
// In the SAME transaction that inserts invocation + dispatch event:
await admitWorkspaceWork(tx, authoritativeWorkspaceId, "bot", invocationId);

// Around each actual external invocation dispatch/execution:
await withWorkspaceWorkBudget(authoritativeWorkspaceId, "bot", invocationId,
  async ({signal, assertLease}) => {
    await assertLease();
    // Revalidate current invocation/install/membership at this final boundary.
    // Pass signal to the bounded HTTP request. Do not derive scope from caller input.
    return executeInvocation({signal});
  });

// In the SAME cancellation transaction:
await cancelWorkspaceWork(tx, authoritativeWorkspaceId, "bot", invocationId);
```

For a long-lived asynchronous remote run, use exported `claimWorkspaceWork(tx,...)`, `assertWorkspaceWorkLease(lease)` and `settleWorkspaceWork(lease,success)` around its real lifetime rather than only the enqueue HTTP call. `withWorkspaceWorkBudget` finishes a lease when its callback returns; do not use it to falsely count a still-running remote job as completed. Duplicate completed/cancelled work returns without invoking the callback. A failed callback returns work to pending and releases concurrency, while preserving its pending charge for retry. Bot source files are owned by the auth lane; this lane wires real attachment completion/worker hooks and provides executable bot-kind admission/lease tests, not an assertion that bot endpoints are already integrated here.

## Reviewed deployment order (no production actions performed here)

1. Freeze the combined PR schema/migration chain 0017/0018/0019; reconcile one journal/snapshot from the combined schema. This lane supplies hand-authored 0019 SQL and schema additions; it deliberately does not forge snapshots for absent predecessor migrations.
2. Back up PostgreSQL and inventory attachment canonical tuples, retained clean versions, existing pending/running bot invocations, bucket rules and worker backlog. Repair earlier malformed tuples by the 0017 preflight runbook. Existing over-budget content is preserved and blocks new reservations. Do not delete it to make quotas pass.
3. Under separately approved CloudFormation change-set authority, remove clean current/noncurrent expiration first and read back the effective bucket rules. This is a separate stateful storage deployment boundary, not an automatic consequence of merging application source. Preserve quarantine encryption/private access/versioning.
4. Quiesce old API/worker writers. Apply migrations using migration authority. 0019 backfills retained charges from canonical attachments; never run older writers afterward because they do not honor admission/lease boundaries. Backfill currently processing attachment work and queued/running bot work through the documented admission seam before accepting traffic, or drain them under maintenance first.
5. Deploy the exact API/worker tuple with reviewed limits and worker authority for durable cleanup. Extend 0017 restricted-role grants/policies to new budget/charge/cleanup tables and trigger functions; API writes must remain scoped, object receipts worker-only. Verify the actual restricted role, not the owner-only development connection.
6. Canary on synthetic objects: authorized uploader deletion, denied member deletion, channel cascade, partial version-delete failure/retry after rows are gone, persistent retained object, explicit deadline reconciliation, concurrent admission and lease recovery. Read both public state and the actual exact-version objects/charge rows back.
7. Monitor pending cleanup oldest age/failures, pending work by tenant/kind, active leases, over-budget tenants and orphan receipts. Do not purge outstanding cleanup receipts or work records as ordinary log retention.

Rollback: disable new traffic/work admission and preserve all durable cleanup/charge tables. Prefer a forward fix. An old binary cannot safely process new deletion/retention/lease states; do not restore it with active writers until an explicit compatibility/drain review. Never re-enable automatic clean expiry, drop cleanup receipts, or restore deleted object versions as part of an application-only rollback. Restoring object/database backups is its own approved recovery operation.

## Executable lane evidence

Focused RED/GREEN logs are kept outside Git under `/workspace/thechat-artifacts/lifecycle/` on the dedicated devbox. They cover authorized attached deletion/history + canonical cascade, explicit retention, multi-uploader byte admission, pending validation admission, multi-handler concurrency/tenant progress, cancellation, durable charges after row removal, bucket-template retention, and promotion/deletion race.

Run from `packages/api` against a disposable migrated PostgreSQL and isolated Redis prefix:

```sh
bun test --env-file ../../.env --timeout=30000 \
  src/attachments/attachments.integration.test.ts \
  src/conversations/channels.test.ts \
  src/services/workspace-resource-budgets.integration.test.ts
pnpm exec tsc --noEmit
```

`workspace-resource-budgets.integration.test.ts` starts **two independent Bun worker processes** against the same PostgreSQL to prove shared leases, then verifies expiry recovery, stale-token fencing, cancellation, idempotence and tenant isolation. Object-store tests use synthetic in-memory bytes only. No AWS calls, production database writes, merge or deployment were performed.
