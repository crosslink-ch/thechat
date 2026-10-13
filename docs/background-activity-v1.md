# Background activity v1 candidate

TheChat is a derived view, not Hermes execution authority. `POST /hermes-platform/activity` authenticates the existing Hermes bot credential, accepts closed v1 full snapshots, binds task/session permanently through a server-verified origin invocation, and never changes its message invocation. A completed origin is valid. Retained provenance survives invocation cleanup.

PostgreSQL snapshot/metadata-only receipt records and an existing transactional outbox carry updates. Redis websocket messages contain only `bot_activity_changed` + `conversationId`; clients re-authorize a normal runtime GET. Reconnect and 30-second safety refetch recover missed updates. Foreground progress remains independent. Private approval/clarification/vault payloads never enter activity.

Identical event+sequence retries acknowledge without refreshing connectivity; conflicting reuse returns 409. Lower complete revisions acknowledge without regressing the projection. Finished/failed/stopped task/worker states cannot reopen. Omitted terminal workers remain sticky, bounded by the 32-worker projection limit; a snapshot exceeding that identity bound returns 409. Unknown is an explicit non-terminal uncertainty, not fabricated progress.

Reads require current conversation participation and workspace membership for activity. When an existing legacy runtime reader lacks new derived visibility, `activity: []` preserves the old foreground/private interaction rails. Outsiders remain denied by the existing runtime route. Terminal activity displays for 24 hours. Cache reads prune at most 64 entries older than seven days, including cascading metadata receipts. No task-wide management domain or canonical worker state is added.

## Shared UI

Desktop: selected-scope task card in the Hermes activity panel; named worker goals, actions and real timestamps, keyboard-accessible bounded recent tool timeline. Phone: the same component remains visible without opening the task drawer, in a contained scroll region. Background badges on sidebar bots use real snapshots for their own DM; task-row counts include background work in other threads without rendering those workers in the selected scope. A stale 90-second heartbeat is `Status unknown / connection lost`.

Task Stop is wired on desktop and phone through authenticated Eden, not through mutable conversation `/stop`. Owners advertise `backgroundTaskControlVersion: 1` during authenticated command registration; legacy registrations clear it. Runtime activity adds optional `canStop`; only confirmed live supported owners get a control. Finished/failed/stopped/unknown owners do not. Client pending state says `Stop requested`, never `Stopped`, until a real owner snapshot confirms settlement.

## Task-bound control v1

`POST /bot-runtime/bots/:botId/activity/:taskId/stop` requires a human principal with current conversation mutation access. The server derives the immutable original session and origin from its retained binding and queues a separate command invocation. It never revives or finalizes the original invocation. Unknown/terminal or unsupported owners return 409; outsiders remain denied. Duplicated accepted requests reuse the bound control invocation.

The owning bot receives an authenticated platform event with a closed additive field:

```json
{"taskControl":{"version":1,"action":"stop","taskId":"<original UUID>","sessionId":"<original opaque session>"}}
```

Hermes admits the control before ordinary `/stop` cancellation in both idle and busy adapter paths. It matches the recorded profile home, transport/conversation/thread, immutable task/session, and only the bound native parent, delegated units and processes. Stop intent persists before signalling. Owned workers must settle before terminal `stopped`; stopped goals cannot begin verification. A shared verifier is not cancelled while unstopped sibling goals depend on it. Existing generic foreground `/stop` and confirmed `/new` compatibility are unchanged. Confirmed `/new` currently stops the prior native process, so paired session-rotation evidence proves old logical-task isolation; focused native PID tests separately prove precise killing while a newer process remains alive.

## Mixed-version rollout

1. Apply expand-only migrations 0017/0018/0019 to the receiver; 0019 adds nullable owner capability without granting it to legacy owners.
2. Deploy API, read surfaces, and every outbox worker with the new handler before allowing a new producer to publish. An old outbox worker treats an unknown event type as permanent; receiver-first includes all consumers, not only HTTP pods.
3. Older clients ignore optional `activity` and the payload-free invalidation. Older producers need no change.
4. New producers must persist before sending, retain event IDs on retries, acknowledge only application `{ok:true,taskId,sequence}`, and treat 404/unknown endpoint as absent capability with bounded retry—not a receipt. Canonical producer/restart behavior is outside TheChat and still requires paired evidence.
5. During rollback retain the outbox handler until pending activity invalidations are drained; do not silently acknowledge/discard incoming snapshots.

## Native gates (disposable services only)

From `packages/api` after migrations, with API/bot workers stopped:

```sh
bun test --isolate --env-file ../../.env --timeout=30000 --path-ignore-patterns=src/auth/rate-limit.test.ts --path-ignore-patterns=src/auth/password-reset.test.ts
bun test --env-file ../../.env src/hermes-platform/activity.integration.test.ts --timeout=30000
```

From `packages/client`:

```sh
pnpm exec vitest run --exclude '**/*.integration.test.ts' --maxWorkers=2
pnpm exec tsc --noEmit
```

Root: `pnpm build:web`, `pnpm build:desktop`, `pnpm build:api`, `pnpm test:boundaries`. Desktop `pnpm --filter @thechat/desktop test` includes live API integration and requires API health.

Receiver/UI-only browser fixture (not real Hermes worker proof):

```sh
THECHAT_WEB_E2E_API_URL=http://127.0.0.1:3000 THECHAT_WEB_E2E_ARTIFACTS=/workspace/background-activity/evidence/thechat/browser pnpm exec playwright test -c scripts/e2e/web/playwright.config.ts scripts/e2e/web/background-activity.spec.ts --project=chromium-desktop --project=chromium-phone
```

It uses real Postgres, Redis, API, auth, message invocation delivery and shared routes, but explicitly scripted producer snapshots. Browser artifacts are outside Git. That fixture alone is not owner proof.

The isolated paired integration now also exercises actual Hermes gateway intake through the real outbox/worker, native terminal background PIDs, actual detached delegation with a foreground child tool, owner snapshots after parent reply, exact lost-ACK retry, authenticated task Stop with a newer goal active, quiet verification tool and final delivery, abrupt restart unknown reconciliation, real principal/workspace rejections, and authenticated desktop/phone reload/keyboard/geometry checks. Only the OpenAI-compatible model inference endpoint is deterministic. Receipts, commands, screenshots and caveats are under `/workspace/background-activity/evidence/integration/`; protected fixture credentials are not evidence deliverables. Initial pilot non-SSE/deadline failures are retained as diagnostics, not claimed as final acceptance.
