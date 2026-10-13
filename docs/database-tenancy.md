# Database tenant isolation and upgrade runbook

## Authority contract

PostgreSQL 17 migration **0017_tenant_database_hardening** is required. RLS is
always enabled for collaboration rows; it is not an opt-in feature flag.

| Process | Environment / Secret key | Required authority |
|---|---|---|
| API collaboration services | `DATABASE_URL` / `databaseSecret` | Separate non-owner, `NOINHERIT`, `NOSUPERUSER`, `NOBYPASSRLS`, no DDL/TRUNCATE/TRIGGER or privileged role membership |
| API authentication/global credentials | `DATABASE_AUTH_URL` / `authDatabaseSecret` | Separate non-owner, `NOBYPASSRLS`, membership in the non-login `thechat_identity_authority` marker; no collaboration-table grants |
| Durable outbox/bot/attachment worker | `DATABASE_WORKER_URL` / `workerDatabaseSecret` | Explicit non-owner, `NOSUPERUSER`, `BYPASSRLS` maintenance login; no DDL or inheritance of migrator/runtime/auth roles |
| Migrations and reviewed repairs | `DATABASE_MIGRATION_URL` / `migrationDatabaseSecret` | Schema/table/function owner or administrator; never supplied to API/worker workloads |

`deploy/database/roles.sql` installs grants without accepting passwords. Supply
all four distinct role names with `psql -v runtime_role=... -v auth_role=...
-v worker_role=... -v migration_role=... -f deploy/database/roles.sql` as the
DB/role administrator after schema migration. Provision distinct login credentials
through the secret manager; new roles start `NOLOGIN`. No `SET ROLE`/inheritance
path from runtime/auth/worker to a schema owner or another authority is permitted.
An existing role's dangerous memberships are deliberately not silently removed:
startup rejects them, and the administrator must review/revoke them explicitly.

The API verifies role attributes/ownership, schema privileges, credential-hash
read privileges, protected table inventory, RLS enablement and **exact canonical
policy expressions** before listening. The worker verifies its explicit
maintenance role before starting. A wrong owner/superuser/BYPASSRLS application
URL, a credential-authority URL with collaboration grants, an unregistered tenant
table, a missing policy, or a weakened/extra policy stops startup.

Maintenance is cross-tenant by design. It is not an application fallback:
`db` rejects missing context, and authenticated requests cannot elevate to worker
context. The worker workload receives no `DATABASE_URL`, `DATABASE_AUTH_URL` or
`DATABASE_MIGRATION_URL`. Authentication storage is lazily initialized so worker
imports do not require authentication credentials.

## Application and service integration

REST composes authenticated identity across Elysia's entire request lifecycle;
MCP wraps the authenticated official transport; WebSocket inbound operations bind
their verified session/API-key identity. Realtime fanout starts a new recipient
context rather than inheriting the sender's transaction or identity. Continue to
check session validity and resource access at delivery; RLS is defense in depth,
not a replacement for service/transport authorization.

```ts
import { db, withDatabaseContext, withWorkerDatabaseContext } from './db';

// actorId MUST originate from verified authentication, not request JSON.
await withDatabaseContext({ actorId: authenticatedUser.id, scope: 'actor' },
  () => serviceOperation(authenticatedUser.id));

// Optional narrowing: scope: `workspace:${workspaceId}` or 'personal'.
// Nesting cannot replace the authenticated actor/scope.
await withWorkerDatabaseContext(() => maintenanceOperation());
```

Fluent Drizzle operations execute within a transaction at await time, with
`set_config(..., true)` actor/scope settings. `db.transaction()` reuses the bound
executor, supports savepoints and retains explicit isolation options. Context
becomes inactive at completion, so detached work cannot reuse a finished request.
Prepared queries outside a context are not supported. No session-wide `SET` is
used; pooled/concurrent requests do not share actor GUCs.

`workspace_id != NULL` means workspace-owned, including DMs. Workspace membership
is required even when a stale conversation participant survives. Personal,
unscoped DMs remain participant-owned. Workspace-wide groups remain visible to
current workspace members; this migration does not introduce private channels.
Legacy unscoped groups are not public.

Workspace creation must insert the workspace, initial owner, General channel and
participant in one SQL transaction. Bootstrap authorization uses row `xmin` in
that transaction, never enduring creator attribution. **Insert known workspace /
conversation IDs without `RETURNING` until membership/participants exist**, then
select/return after enrollment: an RLS lookup cannot see the candidate row during
`INSERT ... RETURNING`. `createOrGetDm` follows this contract. Bot identity reads
have a direct owner clause so atomic bot creation can safely return its own row.

Every new installation, budget or cleanup table with `workspace_id`,
`conversation_id` or `message_id` is discovered by startup. Register it in
`src/db/policies.ts` with exact PostgreSQL policy expressions, use
`collaborationPolicies(tableName)` in its Drizzle schema, and install the same
policy in its migration. The startup gate refuses unregistered additions, even
if their policy mentions a helper while also allowing `OR true`. Use
`thechat_can_workspace(workspace_id)` / `thechat_can_conversation(conversation_id)`
as appropriate. Reapply role grants after migrations. Installation-consent
acceptance by a non-member global bot owner needs narrowly scoped enrollment
permission; do not grant that owner broad workspace-content access.

Global user/bot mutations are also RLS-protected to prevent foreign identity
cascades from laundering tenant deletion. Ordinary bot discovery uses the
`bot_identities` security-barrier projection, not private connector columns.
Only the authentication role may read API-key hashes. The runtime can atomically
insert the first credential for a bot identity it just created, but only read
non-secret `reference_id`, `enabled` and `config_id` credential columns.

## Constraints and compatibility

- Composite message/thread, unread/message and attachment/message FKs reject
  mismatched conversation IDs even when each individual ID exists.
- Invocation trigger/response messages, thread and bot agree with the owning
  conversation. Stored `thread_scope_id = coalesce(thread_id::text, '')` makes
  null an explicit structural scope, not a skipped `MATCH SIMPLE` FK component.
  Trigger/response tuple FKs are **DEFERRABLE INITIALLY DEFERRED**, closing
  concurrent insert/message-thread write skew while permitting atomic child-key
  nulling. Preserve this hand-written migration contract; Drizzle snapshots do
  not represent deferrability or the custom constraint triggers.
- Optional child single-column FKs use `SET NULL`; their composite owner FKs use
  `NO ACTION`. Deleting a thread/response nulls only the optional child key,
  never non-null `conversation_id` or `bot_id`.
- Workspace/thread creator attribution is nullable `ON DELETE SET NULL`, not an
  ownership cascade. Customer workspaces and another member's records survive
  creator deletion.
- Legacy attachment-link writers may omit `conversation_id`; a BEFORE INSERT
  trigger derives it from the message, then NOT NULL and both composite FKs
  validate it. New writers should set the conversation explicitly.
- Message history orders `(created_at,id)` and returns opaque `m1.`
  `paginationCursor` values, including PostgreSQL microseconds and
  conversation/thread scope. Updated clients send the exact cursor; realtime
  and REST-send messages also carry it. Old ISO timestamp `before` values remain
  supported with their original strictly-before-timestamp behavior (old clients
  can still omit ties; update them for complete equal-timestamp pagination).
- `messages_conversation_order_idx` and
  `messages_conversation_thread_order_idx` support normal conversation/thread
  tuple lookups. A separate unique tuple index supports invocation structure.

## Deployment sequence (no production changes performed here)

1. Freeze the candidate and take an independently verified backup/PITR restore
   point. Test the complete combined migration chain on a disposable copy.
2. Quiesce **all** old API writers, workers and maintenance jobs. Never roll old
   unrestricted-role binaries alongside this cutover. The migration takes
   SHARE ROW EXCLUSIVE locks while checking/backfilling/installing constraints.
3. Run the diagnostics below as migration/repair authority. If any rows appear,
   stop, retain a restricted diagnostic export and get a tenant/data-owner review.
4. Apply migrations using only `DATABASE_MIGRATION_URL` (`cd packages/api;
   bun run drizzle-kit migrate`). Migration 0017 raises a preflight exception
   rather than deleting/repairing bad rows. A failed transaction does not advance
   the Drizzle journal or leave a partial column/backfill.
5. Apply `deploy/database/roles.sql` as DB administrator; provision the distinct
   login secrets. Do this **before** starting the new Helm release. The chart
   migration hook uses the migration Secret only and safely reruns the already
   applied migration chain. API receives runtime+auth Secrets; worker receives
   worker authority only. Keep all privileged URLs out of `.Values.env`.
6. Start the candidate, verify successful safety gates and `/health`, then test
   authenticated A/B read/mutation denial, REST/MCP/WebSocket behavior and a
   durable outbox canary with no external provider target.
7. Resume writes only after those gates pass. Record the schema journal, role
   names/attributes/grants and candidate SHA without credential values.

### Fail-closed diagnostics and reviewed repair

Run read-only queries against the legacy database; export IDs/ownership
coordinates only, not message bodies or secrets:

```sql
SELECT m.id,m.conversation_id,m.thread_id,t.conversation_id AS thread_conversation
FROM messages m JOIN conversation_threads t ON t.id=m.thread_id
WHERE m.conversation_id<>t.conversation_id;

SELECT u.message_id,u.user_id,u.conversation_id,m.conversation_id AS message_conversation
FROM message_unreads u JOIN messages m ON m.id=u.message_id
WHERE u.conversation_id<>m.conversation_id;

SELECT l.message_id,l.attachment_id,m.conversation_id,a.conversation_id AS attachment_conversation
FROM message_attachments l JOIN messages m ON m.id=l.message_id
JOIN attachments a ON a.id=l.attachment_id WHERE m.conversation_id<>a.conversation_id;

SELECT i.id,i.conversation_id,i.thread_id,i.bot_id,i.trigger_message_id,i.response_message_id
FROM bot_invocations i JOIN messages m ON m.id=i.trigger_message_id
LEFT JOIN messages r ON r.id=i.response_message_id
LEFT JOIN conversation_threads t ON t.id=i.thread_id
WHERE i.conversation_id<>m.conversation_id OR i.thread_id IS DISTINCT FROM m.thread_id
OR r.id IS NOT NULL AND (i.conversation_id<>r.conversation_id OR i.thread_id IS DISTINCT FROM r.thread_id)
OR t.id IS NOT NULL AND (t.conversation_id<>i.conversation_id OR t.bot_id<>i.bot_id);

SELECT c.id,c.conversation_id,c.branch_from_thread_id,p.conversation_id AS parent_conversation
FROM conversation_threads c JOIN conversation_threads p ON p.id=c.branch_from_thread_id
WHERE c.conversation_id<>p.conversation_id;
```

Classify each row using authoritative ownership evidence. An explicitly reviewed
repair may null a mistaken **optional** thread/branch/response attribution or
correct a proven redundant scope field. Do not retarget a message/file to another
tenant merely to satisfy the FK. Ambiguous/confidentiality-impacting cases block
migration until the data owner decides. Preserve payloads and archive the exact
before/after IDs and approved repair SQL. Apply repairs in a transaction while
writers remain stopped, rerun **all** diagnostics, then retry migrations.
There is no automatic destructive fallback.

### Rollback

Prefer a forward correction. Stop writes/workers before rollback and retain the
new data plus a verified backup. Do not disable RLS, restore creator cascades,
change runtime back to an owner credential, or edit the migration journal to
make an old binary run. Revert application code only if it remains compatible
with the restricted-role/context/schema contract; otherwise restore the verified
pre-cutover database **and** matching old application/credential set together,
with an explicit data-reconciliation plan for writes since the restore point.

## Executable verification

Use explicitly provisioned loopback disposable `*_e2e` databases and four role
URLs. Test fixtures use `db/testing`/`DATABASE_MIGRATION_URL`; service calls use
real restricted-role actor context, not fixture authority. Use a separate empty
upgrade database for `THECHAT_TENANCY_UPGRADE_TEST_URL` and a separate migrated
worker database for `THECHAT_TENANCY_WORKER_TEST_URL`.

From `packages/api`, with an explicit `TMPDIR`:

```sh
bun test --isolate --timeout=35000 src/db/context.integration.test.ts \
  src/db/rls.integration.test.ts src/db/tenant-invariants.integration.test.ts \
  src/db/transport-context.integration.test.ts src/db/worker-context.integration.test.ts \
  src/db/migration-preflight.integration.test.ts src/services/message-pagination.integration.test.ts
```

The upgrade and actual-worker gates intentionally skip when their dedicated URL
is absent; release evidence must execute them explicitly, not count skips as
coverage. Run the auth safety harness for password-reset/rate-limit tests, API
and client typechecks, the full client hook file with `VITEST_MAX_WORKERS=1`,
`python3 deploy/api/tests/test_migration_hook.py` with Helm available, and
`git diff --check`. Parent integration must regenerate coherent later snapshots
and rerun the complete canonical suite after installations/budgets are registered.
