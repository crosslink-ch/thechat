# Integrated tenant isolation and coordinated cutover

## Authority contract

PostgreSQL 17 and the ordered **0017_tenant_database_hardening →
0018_workspace_bot_installations → 0019_workspace_resource_lifecycle** chain
are required. RLS and real lifetime budgets are active implementation, not
opt-in schema-only declarations. This candidate is committed locally only;
publishing, merging and production activation require separate approval.

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

Application `thechat_*` functions revoke PUBLIC execution in the migrations.
The role recipe grants runtime the actor-gated helper/RPC surface and grants
auth/maintenance only their required named helpers. Auth needs even the pure
`thechat_claim_bot_user` predicate referenced by credential RLS: PostgreSQL
checks function permission even when another policy branch admits the row.
Maintenance has no direct endpoint-column UPDATE or EXECUTE on bot endpoint/
command mutation RPCs. Endpoint locking and HMAC signing use narrowly scoped
functions with fixed search path and current-operation checks.

The API verifies role attributes/ownership, schema privileges, credential-hash
read privileges, protected table inventory, RLS enablement and **exact canonical
policy expressions** before listening. The worker verifies its explicit
maintenance role before starting. A wrong owner/superuser/BYPASSRLS application
URL, a credential-authority URL with collaboration grants, an unregistered tenant
table, a missing policy, or a weakened/extra policy stops startup.

Maintenance is cross-tenant by design. Its trusted login can read private bot connector/signing columns through its explicit `bots` SELECT grant; the signer RPC is not a secret-isolation boundary against that worker. Never expose this credential to customers or untrusted adapters. Budget-row RLS enforces tenant scope, while operator-only limit configuration is enforced at the service boundary: members have no public limit-setting operation, but application-role SQL is not an operator/member distinction for these rows.

Maintenance is not an application fallback:
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
permission; do not grant that owner broad workspace-content access. Minimal
`bot_invite_metadata` supports consent and current-inviter checks without a
workspace/roster grant. A narrow owner-withdrawal path drains this bot's work
and persists removal effects without disclosing customer roster IDs. Global
ownership never becomes workspace installation administration.

Global user/bot mutations are also RLS-protected to prevent foreign identity
cascades from laundering tenant deletion. Ordinary bot discovery uses the
`bot_identities` security-barrier projection, not private connector columns.
Only the authentication role may read API-key hashes. The runtime can atomically
insert the first credential for a bot identity it just created, but only read
non-secret `reference_id`, `enabled` and `config_id` credential columns.
`bot_runtime_metadata` is an operational projection without the signing secret;
do not substitute broad private connector reads for it. Bot SQL content reads
also intersect live installation enablement and selected-channel scope.

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

1. Freeze the exact source/tree, API/worker artifact and chart tuple. Preserve
   both merged lanes and one coherent journal/snapshot chain. Take a verified
   backup/PITR restore point and rehearse restoring a disposable copy. Preserve
   exact-version object inventories and old queue/worker evidence separately.
2. Inventory legacy bot memberships, workspace administrators, global owners,
   attachment ceilings and runtime trust boundaries. **Review every legacy
   installation before 0018**: the compatibility backfill explicitly creates
   enabled/all-channel grants, snapshots the global ceiling/current endpoint and
   retains shared-runtime consent for existing memberships. It does not prove
   historical approver identity (`approved_by_id` stays null). Missing approval
   or mixed-customer runtime consent blocks activation; preserve data and make
   an explicit reviewed correction, not an absence-means-permission fallback.
3. Inventory clean current/noncurrent object versions and effective bucket rules.
   If persistent retention is to be enabled, separately approve/apply the
   CloudFormation change removing clean expiration, then read the actual rules
   back. Do not infer a bucket change from application Git or a Helm success.
4. Require compatible remote adapters **before** bot traffic: received epoch
   token echo, silent heartbeat, terminal callbacks and local cancellation on
   rejection/expiry. See [workspace-resource-lifecycle.md](workspace-resource-lifecycle.md).
   No external Hermes deployment or customer runtime provisioning is included.
5. Quiesce **all** old API writers, workers, maintenance jobs, sockets and remote
   producers. Drain/stop active external execution and preserve uncertain run IDs.
   Never roll old unrestricted-role binaries alongside the candidate. Use a
   maintenance-window/Recreate or positively fenced blue/green switch, not an
   implicit mixed-generation RollingUpdate.
6. Run all diagnostics below as migration/repair authority. Any row blocks the
   migration pending a restricted diagnostic export and data-owner decision.
   Repair only proven redundant/optional attribution, never move payloads to a
   different tenant merely to satisfy a FK.
7. Apply the full chain with `DATABASE_MIGRATION_URL` (`cd packages/api;
   pnpm db:migrate`). 0017 fails before partial DDL/journal advancement on bad
   tuples. 0019 preserves attachment charges/history, normalizes recorded legacy
   silent completion without changing its response/time, and cancels uncertain
   legacy active bot work. **Do not replay it** or hand old queue items directly
   to the new workers. Preserve the old namespace and use a reviewed new Redis
   async/realtime prefix or an explicit drain/reconciliation plan.
8. Reapply `deploy/database/roles.sql` as DB administrator and provision the four
   distinct login secrets. Read back attributes, memberships, table/column and
   function grants, policy expressions, owners/search paths and PUBLIC ACLs.
   Execute actual runtime/auth/worker smoke queries; a migration-owner pass is
   not role proof. Never supply migration authority to API/worker workloads.
9. Materialize external Secrets before the blocking Helm migration hook. Its
   migration image/tag must match API/worker, it receives only migration authority,
   and it safely reruns the applied chain. API gets runtime+auth, worker gets only
   worker authority. Keep privileged URLs out of `.Values.env`; Helm rollback
   does not reverse SQL, role, object-store or remote-runtime changes.
10. Start only the candidate. Require safety/startup success and real `/health`,
    synthetic A/B REST/MCP/WS reads and mutations, removal during captured fanout,
    atomic enrollment/inviter races, actual worker publication without API/auth
    credentials, bounded/denied outbound dispatch and full-lifetime lease gates.
    Verify download revocation and exact-version cleanup/charge state with
    synthetic objects in the approved environment.
11. Check installed-client reachability, message cursor/tie behavior and browser
    auth. Old ISO cursors remain compatible but can omit equal-timestamp ties.
    New backend/client update readiness is separate from external-adapter readiness.
12. Resume writes/bots only after all gates pass. Record the exact source/artifact,
    schema journal, role/grant evidence, queue generation, reviewed legacy grants,
    storage rules and restore point without credential values. Monitor pending
    work/cleanup, lease expiry, dead letters and over-budget tenants.

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
worker database for `THECHAT_TENANCY_WORKER_TEST_URL`. If live frontend tests
use a different disposable backend database from the isolated API suite, set
`THECHAT_INTEGRATION_FIXTURE_DATABASE_URL` to that backend's explicit fixture-owner
URL for cleanup only. It retains the loopback/`*_e2e` guard and never replaces
runtime/auth/worker connections.

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
`git diff --check`. The API canonical entry point runs each owning file in its own
Bun process, preserving deadlines and fixture environment. The two guarded auth
files are not silently dropped: `pnpm test:api:password-reset` provisions owned,
disposable migrated/role-separated PostgreSQL plus Mailpit/Redis and executes them.
E2E database bootstrap likewise uses ordered migrations and the actual role recipe,
not `drizzle-kit push` or an owner-backed API.

Execute repository-native `python3 scripts/test.py` (or `pnpm test`) with a real
loopback backend for the integration suite, isolated disposable databases/Redis,
and bounded Vitest worker pressure. Record every selected suite, skip and exit
code. The explicit upgrade/worker URLs above, real-provider S3 and external
Hermes/native UI canaries are distinct gates; do not describe default skips or
loopback/emulator evidence as production/provider verification.

Exactly one read-only independent review applies to the frozen integrated
candidate. Reproduce confirmed findings, correct them as the sole writer and
rerun executable gates; do not substitute a review loop for runtime proof.
