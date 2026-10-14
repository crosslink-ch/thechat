import { sql } from 'drizzle-orm';
import { db } from '../db';
import { requireBotInstallationAccess } from './bot-installation-access';
import { ServiceError } from './errors';
import type { WorkspaceWorkLease } from './workspace-resource-budgets';
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Lock current canonical state and the lease through the actual mutation. */
export async function requireBotWorkLease(tx:Transaction, invocation:{id:string;status:string;requestJson:Record<string,unknown>|null}, conversation:{id:string;workspaceId:string|null}, botUserId:string, token:string|undefined) {
  if (!conversation.workspaceId) return null;
  const grant=await requireBotInstallationAccess(tx,conversation.id,botUserId);
  const [current]=await tx.execute<{status:string;request_json:Record<string,unknown>|null;response_json:Record<string,unknown>|null}>(sql`select status,request_json,response_json from bot_invocations where id=${invocation.id}::uuid for update`);
  if (!current || !token || token!==current.request_json?.workToken || !['running','claimed'].includes(current.status) || current.response_json?.completion) throw new ServiceError('Workspace work lease lost',409);
  if (grant && current.request_json?.installationRevision!==grant.revision) throw new ServiceError('Bot installation changed during execution',403);
  const lease:WorkspaceWorkLease={workspaceId:conversation.workspaceId,kind:'bot',key:invocation.id,token};
  const rows=await tx.execute(sql`select 1 from workspace_work where workspace_id=${lease.workspaceId} and kind='bot' and idempotency_key=${lease.key}
    and state='running' and lease_token=${token} and lease_until>clock_timestamp() for update`);
  if (!rows.length) throw new ServiceError('Workspace work lease lost',409);
  return lease;
}

/** Terminal state and capacity release share the exact callback transaction. */
export async function finishBotWork(tx:Transaction, lease:WorkspaceWorkLease|null, cancelled=false) {
  if (!lease) return;
  await tx.execute(sql`update workspace_work set state=${cancelled?'cancelled':'completed'},lease_token=null,lease_until=null,updated_at=now()
    where workspace_id=${lease.workspaceId} and kind='bot' and idempotency_key=${lease.key} and lease_token=${lease.token} and state='running'`);
}

/** Durable renewal requires an unexpired epoch echoed by the remote adapter. */
export async function renewBotWork(tx:Transaction, lease:WorkspaceWorkLease|null) {
  if (!lease) return null;
  const seconds=Number(process.env.WORKSPACE_WORK_LEASE_SECONDS??120);
  if (!Number.isSafeInteger(seconds)||seconds<1) throw new Error('WORKSPACE_WORK_LEASE_SECONDS must be positive');
  const [renewed]=await tx.execute<{lease_until:Date|string}>(sql`update workspace_work set lease_until=clock_timestamp()+${seconds}*interval '1 second',updated_at=now()
    where workspace_id=${lease.workspaceId} and kind='bot' and idempotency_key=${lease.key} and lease_token=${lease.token} and state='running' and lease_until>clock_timestamp() returning lease_until`);
  if (!renewed) throw new ServiceError('Workspace work lease lost',409);
  return renewed.lease_until instanceof Date?renewed.lease_until:new Date(renewed.lease_until);
}

/** Dead remote work is terminal, never redispatched. Lock invocation then ledger,
 * matching callback/terminal-trigger order; recheck expiry after acquiring both. */
export async function reconcileExpiredBotWork() {
  return db.transaction(async tx=>{
    const candidates=await tx.execute<{idempotency_key:string;workspace_id:string}>(sql`select w.idempotency_key,w.workspace_id from workspace_work w join bot_invocations i on i.id::text=w.idempotency_key
      where w.kind='bot' and w.state='running' and w.lease_until<=clock_timestamp() order by w.lease_until limit 100`);
    let count=0;
    for (const candidate of candidates) {
      const invocations=await tx.execute(sql`select id from bot_invocations where id=${candidate.idempotency_key}::uuid for update skip locked`);
      if (!invocations.length) continue;
      const expired=await tx.execute(sql`select 1 from workspace_work where workspace_id=${candidate.workspace_id} and kind='bot' and idempotency_key=${candidate.idempotency_key}
        and state='running' and lease_until<=clock_timestamp() for update`);
      if (!expired.length) continue;
      await tx.execute(sql`update bot_invocations set status='failed',error='Workspace remote execution lease expired; external work may still exist',completed_at=now(),updated_at=now()
        where id=${candidate.idempotency_key}::uuid and status in ('queued','running','claimed') and response_json->'completion' is null`);
      await tx.execute(sql`update workspace_work set state='cancelled',lease_token=null,lease_until=null,updated_at=now()
        where workspace_id=${candidate.workspace_id} and kind='bot' and idempotency_key=${candidate.idempotency_key} and state='running' and lease_until<=clock_timestamp()`);
      count++;
    }
    return count;
  });
}
