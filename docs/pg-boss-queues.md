# PostgreSQL durable queues (pg-boss)

The API and worker use **pg-boss 12.38.0**, pinned in the lockfile, on **Bun 1.4.2**. PostgreSQL 13+ is required by pg-boss; the acceptance smoke runs against PostgreSQL 17. Redis remains necessary for realtime fanout/presence. BullMQ is retained **only** for the explicit legacy importer, not as a live queue backend.

## Runtime contract

| Queue | Policy | Local concurrency per worker |
| --- | --- | ---: |
| `chat.message.sent` | `key_strict_fifo`, conversation ID as singleton key | 16 |
| `attachment.work` | standard, independent capacity | 1 |
| `bot-request.answer` | standard | 4 |
| `bot.dispatch` | standard | 4 |

Each callback fetches one job. A slow handler occupies only its slot; there is no shared `Promise.all` batch barrier. FIFO is per conversation across worker replicas, not globally. An active head or one backing off after failure blocks later messages for that conversation. **Initially deferred jobs only enter FIFO when due**, so a newly queued future-dated job does not block an immediately runnable sibling; this differs from the old outbox's deferred-head behavior. A permanently failed head is atomically copied to `public.queue_dead_letters` and removed from the live queue, which releases that conversation without losing the failure audit.

Business writes and `boss.send()` use the **same Drizzle/PostgreSQL transaction**, through pg-boss's supported `fromDrizzle(tx, sql)` adapter. The pg-boss infrastructure uses a separate **maximum-two-connection `pg` pool per process**, shared by the producer and both worker clients. `DATABASE_POOL_MAX=6` therefore permits up to eight PostgreSQL connections per worker. LISTEN/NOTIFY, scheduling and per-queue partition tables are disabled. Include all API and worker replicas when sizing PgBouncer; no assumption of transaction pooling is required.

Queue defaults live in `packages/api/src/async/queue.ts`, not environment feature flags:

- Eight total attempts (seven retries), exponential backoff starting at two seconds and capped at five minutes.
- Existing bot dispatch commands retain their configured attempt budget; imported BullMQ jobs retain their spent budget and scheduling time.
- Sixty-second heartbeat, six-hour hard expiry. This is a fixed safety ceiling, **not** adaptive escalating handler timeouts. Cooperative S3/webhook/model I/O receives the job abort signal. Native heartbeat supervision recovers lost workers.
- Graceful worker shutdown allows 20 seconds, then aborts unfinished work. Native shutdown/recovery can consume an attempt; it is not the old custom relay's attempt-free handoff. Kubernetes grants 45 seconds. pg-boss attempt-token fencing prevents an obsolete attempt from acknowledging a newer attempt. Business-side effects remain at-least-once: handlers must stay idempotent, and external webhook receivers must deduplicate invocation/request IDs.
- Completed-job deletion is 30 days; pending retention is ten years. Failed live jobs have deletion disabled by a trigger until archival. Durable failure audits and legacy-import receipts are not automatically pruned.
- Replay creates a new job at the tail of its key, preserving the original audit and recording the replay ID. It does **not** rewind conversation history. A second replay of the same audit is refused. Bot replay refuses missing, completed, cancelled or already claimed invocations.

Polling-only Hermes invocations remain in the existing invocation lifecycle; they do not acquire a redundant dispatch job. Cancellation, revocation and delete-during-validation checks remain at the effect boundary. The old custom outbox claimant, leases, relay, retry/deadline code and live BullMQ worker are removed. `event_outbox` stays in the schema solely as a legacy source/audit for cutover.

## Fresh install / development

Use a task-local `.env` with PostgreSQL and Redis endpoints, then:

```sh
pnpm install --frozen-lockfile
pnpm --filter @thechat/api db:migrate
pnpm --filter @thechat/api queue:setup
pnpm --filter @thechat/api build
pnpm --filter @thechat/api start
# Separate process:
pnpm --filter @thechat/api start:worker
```

`queue:setup` is idempotent and is the **only** pg-boss schema/queue DDL entrypoint. Normal API/worker startup checks schema availability and fails closed with operator guidance; it never silently migrates. Drizzle owns the two public audit/receipt tables. The migrate image runs Drizzle migrations followed by queue setup. `scripts/dev.py` also runs setup after its local schema push.

The build includes `dist/scripts/{worker,queue-setup,queue-cutover,outbox-dlq}.js`. Use the exact same immutable image revision for API, worker and migration jobs. Never upgrade the pg-boss package without rerunning the compatibility and compiled smoke tests.

## Existing installation: stopped-world cutover

**This is not a rolling upgrade.** A normal Helm pre-upgrade hook does not stop existing producers. Do not just deploy the new image and assume the migration hook transfers outstanding work.

1. Schedule a maintenance window. Stop **all** old and new API/worker replicas and scheduled attachment-cleanup / bot-request-expiry producers. Prevent automatic reconciliation from restarting them. Confirm no traffic can create invocations or outbox rows.
2. Drain old active BullMQ work before stopping workers. If delivery outcomes are ambiguous, stop the workers and explicitly choose quarantine rather than automatic redelivery.
3. Back up PostgreSQL and Redis at this stopped point. Retain the current image tags, deployed values and original queue inventories. Keep the legacy source data until the cutover and reconciliation have been accepted.
4. Run the new migration image (Drizzle plus queue setup). It does not run cutover automatically.
5. With the correct `DATABASE_URL`, `REDIS_URL` and existing `REDIS_KEY_PREFIX`, run:

   ```sh
   bun run dist/scripts/queue-cutover.js --stopped
   # Only if old workers are certainly stopped and active work is ambiguous:
   bun run dist/scripts/queue-cutover.js --stopped --quarantine-active
   ```

   `--stopped` is an operator assertion, not an automatic shutdown mechanism. The command rejects live registered pg-boss workers, persistently pauses the legacy BullMQ queue and installs an INSERT-rejecting trigger on `event_outbox`. It never deletes original outbox rows or Redis jobs. Unsupported legacy jobs abort the operation and remain available for inspection.

6. Save the JSON summary. The importer preserves pending/delayed work, key order, spent retries, failed work and orphan invocations from the old PostgreSQL/Redis dual-write gap. It paginates every Redis state independently, verifies a stable ID/content inventory after import, and checks all unpublished outbox rows have receipts. Ambiguous active/running work is audited, not blindly redelivered. Inspect those audits before manually replaying.
7. An interrupted import can be rerun with both stacks still stopped. Durable `queue_legacy_imports` receipts commit atomically with each destination job/audit and remain after completed-job retention, so a later rerun cannot duplicate already imported effects. BullMQ receipt sources include the queue prefix and name.
8. Start only the new worker and API. Verify health, live queue counts, oldest-ready age, failure audits, representative bot/attachment/answer delivery and traces. Keep the old BullMQ queue paused and old outbox producer fence installed. Do not start old and new consumers together.

**Rollback:** before enabling any new writer/consumer, a coordinated restore of the stopped PostgreSQL and Redis backups plus the old image is the safe rollback boundary. Do not resume legacy sources after a partial cutover without also reconciling destination jobs and receipts. Once the new system has accepted writes or delivered effects, a blind `helm rollback` or pre-cutover database restore is unsafe; keep it stopped and reconcile new jobs, invocation states and external deliveries before a rollback, or fix forward. Backups and audit rows are not proof that a webhook was or was not received.

## Failure operations

The executable keeps its historical `outbox-dlq.js` filename for image compatibility, but operates on pg-boss audits:

```sh
bun run dist/scripts/outbox-dlq.js list
bun run dist/scripts/outbox-dlq.js archive
bun run dist/scripts/outbox-dlq.js replay chat.message.sent <job-uuid>
```

`list` returns at most 100 metadata-only rows, not payloads. Exit codes: 0 success, 1 missing/already-replayed/refused/error, 2 invalid arguments. For a complete backlog use a read-only database query:

```sql
SELECT queue, count(*) FROM queue_dead_letters WHERE replay_id IS NULL GROUP BY queue;
SELECT name, state, count(*) FROM pgboss.job GROUP BY name, state ORDER BY name, state;
SELECT source, count(*) FROM queue_legacy_imports GROUP BY source;
```

Full audit payloads are privileged application data. Do not put them in logs, tickets or metrics. Do not manually delete a failed strict-FIFO head before its audit is durable.

## Observability

Configure `OTEL_EXPORTER_OTLP_ENDPOINT` (or explicit traces/metrics endpoints). The worker exports native `messaging.client.*`, `messaging.process.duration`, and `pgboss.queue.jobs` instruments, plus `thechat.queue.dead_letters` and `thechat.queue.oldest_ready_age`. Metrics export every 15 seconds; native queue gauges follow pg-boss's queue-cache refresh. The age gauge excludes intentionally future-scheduled work. Use low-cardinality queue/state attributes, never payloads, URLs or auth tokens. Trace context propagates from the business transaction into the worker consumer span; sanitized failures retain error classification, not application content.

## Verification

With the local API/Redis/PostgreSQL fixture running:

```sh
python3 scripts/test.py typecheck api integration
python3 scripts/test.py client web desktop client-boundaries
# Creates and drops a NEW random database, never changes the source database:
THECHAT_QUEUE_SMOKE_ALLOW_DATABASE_CREATE=1 pnpm --filter @thechat/api queue:smoke
```

The explicit smoke requires a loopback PostgreSQL test role with CREATEDB permission and loopback Redis. It builds actual artifacts, runs fresh Drizzle migrations, tests missing-schema startup and repeat setup, exercises the compiled worker and DLQ CLI, checks built API health, collects real HTTP OTLP exports and a cross-process trace, checks payload redaction and bounded pools, then verifies SIGTERM/deregistration and drops its database. Unit/integration coverage additionally exercises rollback/deduplication, strict-key ordering, free-slot refill under a hung attachment, eight-attempt exhaustion, permanent quarantine/replay, heartbeat recovery, abort/expiry and stale acknowledgements, revocation/deletion safety, and resumable legacy import including a 302-job multi-state pagination regression.
