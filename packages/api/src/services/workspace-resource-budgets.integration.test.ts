import { afterAll, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import { conversations, users, workspaces } from "../db/schema";
import { enforceWorkspaceRetainedBytes, admitWorkspaceWork, assertWorkspaceWorkLease, cancelWorkspaceWork, claimWorkspaceWork,
  settleWorkspaceWork, withWorkspaceWorkBudget, type WorkspaceWorkLease } from "./workspace-resource-budgets";

const ids: string[] = [];
let creator: string;
afterAll(async () => {
  if (ids.length) await db.delete(workspaces).where(inArray(workspaces.id,ids));
  if (creator) await db.delete(users).where(eq(users.id,creator));
});
async function workspace() {
  if (!creator) {
    creator = crypto.randomUUID();
    await db.insert(users).values({ id: creator, name: "Budget fixture", type: "human" });
  }
  const id = `budget-${crypto.randomUUID()}`;
  await db.insert(workspaces).values({ id, name: "Budget synthetic workspace", createdById: creator });
  ids.push(id);
  await db.execute(sql`insert into workspace_resource_limits values (${id},9223372036854775807,2,2,1,1)`);
  return id;
}
const admit = (id: string,key: string,kind: "bot"|"validation"="bot") => db.transaction(tx => admitWorkspaceWork(tx,id,kind,key));
const claim = (id: string,key: string) => db.transaction(tx => claimWorkspaceWork(tx,id,"bot",key));

describe("workspace work budgets on PostgreSQL", () => {
  test("retained sums preserve exact bigint boundaries above int32 and IEEE precision",async () => {
    const a=await workspace(); const b=await workspace(); const c=crypto.randomUUID(); const other=crypto.randomUUID();
    await db.insert(conversations).values([{id:c,type:"group",workspaceId:a,name:"first"},{id:other,type:"group",workspaceId:b,name:"other"}]);
    await db.execute(sql`update workspace_resource_limits set retained_bytes=18014398509481983 where workspace_id=${a}`);
    for(let i=0;i<2;i++) await db.execute(sql`insert into workspace_attachment_charges(attachment_id,workspace_id,bytes,capability_until)
      values(${crypto.randomUUID()},${a},9007199254740991,now())`);
    await db.transaction(tx => enforceWorkspaceRetainedBytes(tx,c,1));
    await expect(db.transaction(tx => enforceWorkspaceRetainedBytes(tx,c,2))).rejects.toMatchObject({status:429});
    await db.transaction(tx => enforceWorkspaceRetainedBytes(tx,other,2));
  });
  test("concurrent bot admission is bounded, idempotent, and isolated per tenant", async () => {
    const a = await workspace(); const b = await workspace();
    const outcomes = await Promise.all(Array.from({length: 8},(_,i) => admit(a,`job-${i}`).then(() => 200,(e: any) => e.status)));
    expect(outcomes.filter(x => x===200)).toHaveLength(2);
    expect(outcomes.filter(x => x===429)).toHaveLength(6);
    const rows = await db.execute<{ idempotency_key: string }>(sql`select idempotency_key from workspace_work where workspace_id=${a}`);
    await admit(a,rows[0]!.idempotency_key);
    await admit(b,rows[0]!.idempotency_key);
    await db.transaction(tx => cancelWorkspaceWork(tx,a,"bot",rows[0]!.idempotency_key));
    await admit(a,"after-cancel");
    expect(await db.execute(sql`select 1 from workspace_work where workspace_id=${b} and state='pending'`)).toHaveLength(1);
  });

  test("independent worker processes share leases, recover expiry and fence stale completion", async () => {
    const id = await workspace(); await admit(id,"first"); await admit(id,"second");
    const code = `import {db} from './src/db'; import {claimWorkspaceWork} from './src/services/workspace-resource-budgets';
      try { const lease=await db.transaction(tx=>claimWorkspaceWork(tx,${JSON.stringify(id)},'bot','first')); console.log(JSON.stringify({status:200,lease})); }
      catch(e){console.log(JSON.stringify({status:e.status}));} process.exit(0);`;
    const workers = Array.from({length:2},() => Bun.spawn([process.execPath,"-e",code], {cwd: process.cwd(),env: process.env,stdout:"pipe",stderr:"pipe"}));
    const outcomes = await Promise.all(workers.map(async worker => {
      const text = await new Response(worker.stdout).text();
      expect(await worker.exited).toBe(0); return JSON.parse(text);
    }));
    expect(outcomes.map(o => o.status).sort()).toEqual([200,429]);
    const stale = outcomes.find(o => o.lease)!.lease as WorkspaceWorkLease;
    await expect(claim(id,"second")).rejects.toMatchObject({status:429});
    await db.execute(sql`update workspace_work set lease_until=now()-interval '1 second' where workspace_id=${id} and idempotency_key='first'`);
    const renewed = (await claim(id,"first"))!;
    expect(renewed.token).not.toBe(stale.token);
    await expect(assertWorkspaceWorkLease(stale)).rejects.toMatchObject({status:409});
    await settleWorkspaceWork(stale,true);
    await assertWorkspaceWorkLease(renewed);
    await settleWorkspaceWork(renewed,true);
    const second = (await claim(id,"second"))!;
    await db.transaction(tx => cancelWorkspaceWork(tx,id,"bot","second"));
    await expect(assertWorkspaceWorkLease(second)).rejects.toMatchObject({status:409});
    await settleWorkspaceWork(second,true);
    const [cancelled] = await db.execute<{state:string}>(sql`select state from workspace_work where workspace_id=${id} and idempotency_key='second'`);
    expect(cancelled!.state).toBe("cancelled");
  });

  test("heartbeat keeps long work leased and cancellation aborts its callback",async () => {
    const old=process.env.WORKSPACE_WORK_LEASE_SECONDS; process.env.WORKSPACE_WORK_LEASE_SECONDS="1";
    try {
      const id=await workspace();
      expect(await withWorkspaceWorkBudget(id,"bot","long",async ({assertLease}) => {
        await Bun.sleep(1250); await assertLease(); return "renewed";
      })).toBe("renewed");
      await expect(withWorkspaceWorkBudget(id,"bot","cancel",async ({signal,assertLease}) => {
        await db.transaction(tx=>cancelWorkspaceWork(tx,id,"bot","cancel"));
        await Bun.sleep(500); expect(signal.aborted).toBe(true); await assertLease();
      })).rejects.toThrow("Workspace work lease lost");
    }finally{if(old===undefined)delete process.env.WORKSPACE_WORK_LEASE_SECONDS;else process.env.WORKSPACE_WORK_LEASE_SECONDS=old;}
  });
  test("FIFO and failed/cancelled execution do not monopolize another workspace", async () => {
    const a = await workspace(); const b = await workspace();
    await admit(a,"older"); await admit(a,"newer");
    await expect(claim(a,"newer")).rejects.toMatchObject({status:429});
    await expect(withWorkspaceWorkBudget(a,"bot","older",async () => {throw new Error("fixture failure");})).rejects.toThrow("fixture failure");
    expect(await withWorkspaceWorkBudget(b,"bot","independent",async ({assertLease}) => {await assertLease(); return "progress";})).toBe("progress");
    await db.transaction(tx => cancelWorkspaceWork(tx,a,"bot","older"));
    let invoked=false;
    await withWorkspaceWorkBudget(a,"bot","older",async () => {invoked=true;});
    expect(invoked).toBe(false);
    expect(await withWorkspaceWorkBudget(a,"bot","newer",async () => "recovered")).toBe("recovered");
    await admit(a,"capacity-released");
  });
});
