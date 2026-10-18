import crypto from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../db";
import { ServiceError } from "./errors";

type Executor = Pick<typeof db, "execute">;
export type WorkspaceLimits = {
  retained_bytes: string;
  pending_validation: number;
  pending_bot: number;
  concurrent_validation: number;
  concurrent_bot: number;
};

function integerSetting(name: string, fallback: number) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive safe integer`);
  return parsed;
}

export async function lockWorkspaceResourceLimits(tx: Executor, workspaceId: string): Promise<WorkspaceLimits> {
  const bytes = process.env.WORKSPACE_RETAINED_BYTES_LIMIT ?? "10737418240";
  if (!/^[1-9][0-9]*$/.test(bytes) || BigInt(bytes) > 9223372036854775807n) throw new Error("WORKSPACE_RETAINED_BYTES_LIMIT must be a positive PostgreSQL bigint");
  await tx.execute(sql`insert into workspace_resource_limits(workspace_id,retained_bytes,pending_validation,pending_bot,concurrent_validation,concurrent_bot)
    values (${workspaceId},${bytes},${integerSetting("WORKSPACE_PENDING_VALIDATION_LIMIT",32)},${integerSetting("WORKSPACE_PENDING_BOT_LIMIT",32)},
      ${integerSetting("WORKSPACE_CONCURRENT_VALIDATION_LIMIT",1)},${integerSetting("WORKSPACE_CONCURRENT_BOT_LIMIT",2)}) on conflict do nothing`);
  const rows = await tx.execute<WorkspaceLimits>(sql`select retained_bytes::text,pending_validation,pending_bot,concurrent_validation,concurrent_bot
    from workspace_resource_limits where workspace_id=${workspaceId} for update`);
  if (!rows[0]) throw new ServiceError("Workspace not found",404);
  return rows[0];
}

export type WorkspaceWorkKind = "validation" | "bot";

export async function admitWorkspaceWork(tx: Executor, workspaceId: string, kind: WorkspaceWorkKind, idempotencyKey: string) {
  if (!idempotencyKey || idempotencyKey.length > 500) throw new ServiceError("Invalid work idempotency key",400);
  const limits = await lockWorkspaceResourceLimits(tx, workspaceId);
  const existing = await tx.execute(sql`select 1 from workspace_work where workspace_id=${workspaceId} and kind=${kind} and idempotency_key=${idempotencyKey}`);
  if (existing.length) return;
  const [usage] = await tx.execute<{ count: number }>(sql`select count(*)::int as count from workspace_work
    where workspace_id=${workspaceId} and kind=${kind} and state in ('pending','running')`);
  if ((usage?.count ?? 0) >= (kind === "validation" ? limits.pending_validation : limits.pending_bot)) {
    throw new ServiceError(`Workspace pending ${kind} work budget exceeded`,429);
  }
  await tx.execute(sql`insert into workspace_work(workspace_id,kind,idempotency_key) values (${workspaceId},${kind},${idempotencyKey})`);
}

export interface WorkspaceWorkLease {
  workspaceId: string;
  kind: WorkspaceWorkKind;
  key: string;
  token: string;
}

export async function claimWorkspaceWork(tx: Executor, workspaceId: string, kind: WorkspaceWorkKind, key: string, leaseSeconds = integerSetting("WORKSPACE_WORK_LEASE_SECONDS",120)): Promise<WorkspaceWorkLease | null> {
  const limits = await lockWorkspaceResourceLimits(tx, workspaceId);
  // Validation can be retried with a new fenced epoch. External bot execution
  // cannot: maintenance terminalizes expired bot runs before any new admission.
  if (kind === 'validation') await tx.execute(sql`update workspace_work set state='pending',lease_token=null,lease_until=null,updated_at=now()
    where workspace_id=${workspaceId} and kind=${kind} and state='running' and lease_until<=now()`);
  const [current] = await tx.execute<{ state: string }>(sql`select state from workspace_work where workspace_id=${workspaceId} and kind=${kind} and idempotency_key=${key}`);
  if (!current) throw new ServiceError("Work must be admitted before claim",409);
  if (current.state === "completed" || current.state === "cancelled") return null;
  const [usage] = await tx.execute<{ count: number }>(sql`select count(*)::int as count from workspace_work
    where workspace_id=${workspaceId} and kind=${kind} and state='running' and lease_until>now()`);
  const [oldest] = await tx.execute<{ idempotency_key: string }>(sql`select idempotency_key from workspace_work
    where workspace_id=${workspaceId} and kind=${kind} and state='pending' order by created_at,idempotency_key limit 1`);
  if ((usage?.count ?? 0) >= (kind === "validation" ? limits.concurrent_validation : limits.concurrent_bot) || oldest?.idempotency_key !== key) {
    throw new ServiceError(`Workspace ${kind} concurrency budget busy`,429);
  }
  const token = crypto.randomUUID();
  await tx.execute(sql`update workspace_work set state='running',lease_token=${token},lease_until=now()+${leaseSeconds}*interval '1 second',updated_at=now()
    where workspace_id=${workspaceId} and kind=${kind} and idempotency_key=${key}`);
  return { workspaceId, kind, key, token };
}

export async function assertWorkspaceWorkLease(lease: WorkspaceWorkLease) {
  const rows = await db.execute(sql`select 1 from workspace_work where workspace_id=${lease.workspaceId} and kind=${lease.kind}
    and idempotency_key=${lease.key} and state='running' and lease_token=${lease.token} and lease_until>now()`);
  if (!rows.length) throw new ServiceError("Workspace work lease lost",409);
}

export async function settleWorkspaceWork(lease: WorkspaceWorkLease, success: boolean) {
  await db.execute(sql`update workspace_work set state=${success ? "completed" : "pending"},lease_token=null,lease_until=null,updated_at=now()
    where workspace_id=${lease.workspaceId} and kind=${lease.kind} and idempotency_key=${lease.key}
    and state='running' and lease_token=${lease.token} and lease_until>now()`);
}

export async function cancelWorkspaceWork(tx: Executor, workspaceId: string, kind: WorkspaceWorkKind, key: string) {
  await tx.execute(sql`update workspace_work set state='cancelled',lease_token=null,lease_until=null,updated_at=now()
    where workspace_id=${workspaceId} and kind=${kind} and idempotency_key=${key} and state in ('pending','running')`);
}

export async function withWorkspaceWorkBudget<T>(workspaceId: string, kind: WorkspaceWorkKind, key: string,
  operation: (context: { signal: AbortSignal; assertLease: () => Promise<void>; lease: WorkspaceWorkLease }) => Promise<T>): Promise<T | undefined> {
  const seconds = integerSetting("WORKSPACE_WORK_LEASE_SECONDS",120);
  const lease = await db.transaction(async tx => {
    await admitWorkspaceWork(tx,workspaceId,kind,key);
    return claimWorkspaceWork(tx,workspaceId,kind,key,seconds);
  });
  if (!lease) return;
  const controller = new AbortController();
  const assertLease = async () => { controller.signal.throwIfAborted(); await assertWorkspaceWorkLease(lease); };
  let renewing = false;
  const timer = setInterval(async () => {
    if (renewing) return;
    renewing = true;
    try {
      const renewed = await db.execute(sql`update workspace_work set lease_until=now()+${seconds}*interval '1 second',updated_at=now()
        where workspace_id=${workspaceId} and kind=${kind} and idempotency_key=${key} and lease_token=${lease.token}
        and state='running' and lease_until>now() returning idempotency_key`);
      if (!renewed.length) controller.abort(new Error("Workspace work lease lost"));
    } catch (error) { controller.abort(error); }
    finally { renewing = false; }
  }, Math.max(100, Math.floor(seconds*1000/3)));
  try {
    await assertLease();
    const result = await operation({ signal: controller.signal, assertLease, lease });
    // A canonical bot terminal trigger can settle before ancillary notification
    // delivery returns. Accept only this epoch's recorded terminal transition.
    if (kind === 'bot') {
      const [terminal] = await db.execute<{state:string}>(sql`select w.state from workspace_work w join bot_invocations i on i.id::text=w.idempotency_key
        where w.workspace_id=${workspaceId} and w.kind='bot' and w.idempotency_key=${key} and w.state in ('completed','cancelled')
        and i.request_json->>'workToken'=${lease.token} and i.status in ('completed','failed','cancelled')`);
      if (terminal) return terminal.state==='completed' ? result : undefined;
    }
    await assertLease();
    await settleWorkspaceWork(lease,true);
    return result;
  } catch (error) {
    await settleWorkspaceWork(lease,false);
    throw error;
  } finally { clearInterval(timer); }
}

export async function enforceWorkspaceRetainedBytes(tx: Executor, conversationId: string, addedBytes: number) {
  const [conversation] = await tx.execute<{ workspace_id: string | null }>(sql`select workspace_id from conversations where id=${conversationId}`);
  if (!conversation?.workspace_id) return; // Personal DMs retain uploader safeguards.
  const limits = await lockWorkspaceResourceLimits(tx, conversation.workspace_id);
  const [usage] = await tx.execute<{ bytes: string }>(sql`select coalesce(sum(bytes),0)::text as bytes
    from workspace_attachment_charges where workspace_id=${conversation.workspace_id}
    and (released_at is null or capability_until>now())`);
  if (BigInt(usage?.bytes ?? "0") + BigInt(addedBytes) > BigInt(limits.retained_bytes)) {
    throw new ServiceError("Workspace retained attachment quota exceeded",429);
  }
}
