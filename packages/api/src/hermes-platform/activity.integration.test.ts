import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { botInvocations, botActivitySnapshots, messages, users, workspaces, workspaceMembers, eventOutbox } from "../db/schema";
import { authRoutes } from "../auth";
import { workspaceRoutes } from "../workspaces";
import { conversationRoutes } from "../conversations";
import { botRoutes } from "../bots";
import { botRuntimeRoutes } from "../bot-runtime";
import { hermesPlatformRoutes } from "./index";
import { closeRealtimeBusForTests } from "../realtime";
import { RedisRealtimeBus, setRealtimeBusForTests } from "../realtime";
import { createDefaultDomainEventRegistry } from "../events/runtime";
const app = new Elysia().use(authRoutes).use(workspaceRoutes).use(conversationRoutes).use(botRoutes).use(botRuntimeRoutes).use(hermesPlatformRoutes);
const userIds: string[] = [], workspaceIds: string[] = [];
async function request(method: string, path: string, body?: unknown, token?: string) {
  const response = await app.handle(new Request(`http://localhost${path}`, { method, headers: { ...(token ? {authorization: `Bearer ${token}`} : {}), ...(body ? {"content-type": "application/json"} : {}) }, body: body ? JSON.stringify(body) : undefined }));
  const text = await response.text();
  let data: any; try { data = JSON.parse(text); } catch { data = text; }
  return {status: response.status, data};
}
async function ok(method: string, path: string, body?: unknown, token?: string) {
  const result = await request(method,path,body,token); expect(result.status, JSON.stringify(result.data)).toBe(200); return result.data;
}
let f: any;
async function fixture() {
  const human = await ok("POST", "/auth/register", {name:"Synthetic background user",email:`activity-${crypto.randomUUID()}@example.invalid`,password:`Synthetic-${crypto.randomUUID()}-9!`});
  userIds.push(human.user.id);
  const workspace = await ok("POST", "/workspaces/create", {name:"Synthetic activity workspace"}, human.accessToken); workspaceIds.push(workspace.id);
  const bot = await ok("POST", "/bots/create", {name:"Synthetic Hermes",kind:"hermes",workspaceId:workspace.id}, human.accessToken); userIds.push(bot.userId);
  const dm = await ok("POST", "/conversations/dm", {workspaceId:workspace.id,otherUserId:bot.userId}, human.accessToken);
  const [message] = await db.insert(messages).values({conversationId:dm.id,senderId:human.user.id,content:"Synthetic isolated worker request"}).returning();
  const [invocation] = await db.insert(botInvocations).values({botId:bot.id,conversationId:dm.id,triggerMessageId:message!.id,adapterKind:"hermes",status:"claimed",completedAt:new Date(),responseJson:{completion:{type:"message"},output:"Parent has replied"}}).returning();
  return {human,workspace,bot,dm,invocation};
}
function snapshot(overrides: any = {}) {
  const now = new Date().toISOString();
  return {schemaVersion:1,eventId:crypto.randomUUID(),taskId:crypto.randomUUID(),sequence:1,originInvocationId:f.invocation.id,sessionId:"synthetic-session",occurredAt:now,parent:{state:"waiting_worker",action:null,updatedAt:now},workers:[{id:"worker-1",kind:"subagent",parentId:null,goal:"Synthetic isolated background check",state:"running",action:"terminal",startedAt:now,updatedAt:now,lastActionAt:now}],activities:[{id:"tool-1",workerId:"worker-1",toolName:"terminal",state:"running",startedAt:now,finishedAt:null}],...overrides};
}
beforeAll(async () => { f = await fixture(); });
afterAll(async () => { await closeRealtimeBusForTests(); for (const id of workspaceIds) await db.delete(workspaces).where(eq(workspaces.id,id)); if(userIds.length) await db.delete(users).where(inArray(users.id,userIds)); });
describe("durable background activity", () => {
  test("stop eligibility follows the exact owner capability across upgrade and legacy registration", async () => {
    const owner = await fixture();
    const input = snapshot({originInvocationId:owner.invocation.id});
    await ok("POST","/hermes-platform/activity",input,owner.bot.apiKey);
    const displayed = async () => (await ok("GET",`/bot-runtime/conversations/${owner.dm.id}`,undefined,owner.human.accessToken)).activity.find((task:any)=>task.taskId===input.taskId);
    expect((await displayed()).canStop).toBe(false);
    await ok("POST","/bots/me/commands",{commands:[],backgroundTaskControlVersion:1},owner.bot.apiKey);
    expect((await displayed()).canStop).toBe(true);
    await ok("POST","/bots/me/commands",{commands:[]},owner.bot.apiKey);
    expect((await displayed()).canStop).toBe(false);
  });
  test("authorized task stop queues the immutable original task binding without claiming stopped", async () => {
    await ok("POST", "/bots/me/commands", {commands:[],backgroundTaskControlVersion:1}, f.bot.apiKey);
    const input = snapshot();
    await ok("POST", "/hermes-platform/activity", input, f.bot.apiKey);
    const receipt = await request("POST", `/bot-runtime/bots/${f.bot.id}/activity/${input.taskId}/stop`, {}, f.human.accessToken);
    expect(receipt.status).toBe(200);
    expect(receipt.data).toMatchObject({ok:true,taskId:input.taskId,state:"requested"});
    const claimed = await ok("GET", "/hermes-platform/events?limit=10", undefined, f.bot.apiKey);
    const control = claimed.events.find((event:any) => event.invocationId === receipt.data.invocationId);
    expect(control).toMatchObject({chatId:f.dm.id,threadId:null,text:"/stop",taskControl:{version:1,action:"stop",taskId:input.taskId,sessionId:input.sessionId}});
    const runtime = await ok("GET", `/bot-runtime/conversations/${f.dm.id}`, undefined, f.human.accessToken);
    expect(runtime.activity.find((task:any) => task.taskId === input.taskId).parent.state).toBe("waiting_worker");
    const [origin] = await db.select().from(botInvocations).where(eq(botInvocations.id,f.invocation.id));
    expect(origin!.completedAt).toEqual(f.invocation.completedAt);
  });
  test("unknown ownership after restart cannot advertise or enqueue task-scoped Stop", async () => {
    const owner=await fixture();
    await ok("POST","/bots/me/commands",{commands:[],backgroundTaskControlVersion:1},owner.bot.apiKey);
    const now=new Date().toISOString();
    const input=snapshot({originInvocationId:owner.invocation.id,parent:{state:"unknown",action:null,updatedAt:now}});
    await ok("POST","/hermes-platform/activity",input,owner.bot.apiKey);
    const runtime=await ok("GET",`/bot-runtime/conversations/${owner.dm.id}`,undefined,owner.human.accessToken);
    expect(runtime.activity.find((task:any)=>task.taskId===input.taskId).canStop).toBe(false);
    expect((await request("POST",`/bot-runtime/bots/${owner.bot.id}/activity/${input.taskId}/stop`,{},owner.human.accessToken)).status).toBe(409);
  });
  test("terminal worker state survives omission from a later full snapshot", async () => {
    const input = snapshot(); await ok("POST","/hermes-platform/activity",input,f.bot.apiKey);
    await ok("POST","/hermes-platform/activity",{...input,eventId:crypto.randomUUID(),sequence:2,workers:[{...input.workers[0],state:"finished"}]},f.bot.apiKey);
    await ok("POST","/hermes-platform/activity",{...input,eventId:crypto.randomUUID(),sequence:3,workers:[]},f.bot.apiKey);
    expect((await request("POST","/hermes-platform/activity",{...input,eventId:crypto.randomUUID(),sequence:4},f.bot.apiKey)).status).toBe(409);
  });
  test("closed metadata payloads reject raw tool args, invalid timestamps and foreign routes", async () => {
    const other = await fixture(); const input = snapshot();
    expect((await request("POST","/hermes-platform/activity",input,other.bot.apiKey)).status).toBe(404);
    expect((await request("GET",`/bot-runtime/conversations/${f.dm.id}`,undefined,other.human.accessToken)).status).toBe(403);
    for (const invalid of [{...input,conversationId:other.dm.id},{...input,sessionId:" surrounding "},{...input,sequence:Number.MAX_SAFE_INTEGER+1},{...input,occurredAt:"2026-10-12T09:00:00"},{...input,workers:[{...input.workers[0],args:{secret:"must-not-persist"}}]}]) {
      expect((await request("POST","/hermes-platform/activity",invalid,f.bot.apiKey)).status).toBe(400);
    }
  });
  test("recent terminal display and derived cache retention are bounded", async () => {
    const input = snapshot({parent:{state:"finished",action:null,updatedAt:new Date().toISOString()},workers:[],activities:[]});
    await ok("POST","/hermes-platform/activity",input,f.bot.apiKey);
    await db.update(botActivitySnapshots).set({observedAt:new Date(Date.now()-2*86_400_000)}).where(eq(botActivitySnapshots.taskId,input.taskId));
    let runtime = await ok("GET",`/bot-runtime/conversations/${f.dm.id}`,undefined,f.human.accessToken);
    expect(runtime.activity.some((row:any) => row.taskId === input.taskId)).toBe(false);
    await db.update(botActivitySnapshots).set({observedAt:new Date(Date.now()-8*86_400_000)}).where(eq(botActivitySnapshots.taskId,input.taskId));
    await ok("GET",`/bot-runtime/conversations/${f.dm.id}`,undefined,f.human.accessToken);
    expect(await db.select().from(botActivitySnapshots).where(eq(botActivitySnapshots.taskId,input.taskId))).toEqual([]);
  });
  test("committed snapshots invalidate authorized clients through the durable outbox and real Redis", async () => {
    const input = snapshot(); await ok("POST","/hermes-platform/activity",input,f.bot.apiKey);
    const rows = await db.select().from(eventOutbox).where(and(eq(eventOutbox.eventType,"hermes.activity.changed"),eq(eventOutbox.aggregateId,input.taskId)));
    expect(rows).toHaveLength(1);
    const bus = new RedisRealtimeBus({channel:`activity-test-${crypto.randomUUID()}`});
    await setRealtimeBusForTests(bus); const events:any[] = [];
    const unsubscribe = await bus.subscribe(event => {events.push(event);});
    try {
      await createDefaultDomainEventRegistry().dispatch(rows[0]!.event,{rejectMissing:true});
      const deadline = Date.now()+3_000; while (!events.length && Date.now()<deadline) await Bun.sleep(20);
      expect(events[0]?.event).toEqual({type:"bot_activity_changed",conversationId:f.dm.id});
      expect(events[0]?.targetUserIds).toContain(f.human.user.id);
      expect(JSON.stringify(events[0])).not.toContain(input.workers[0].goal);
    } finally { await unsubscribe(); await closeRealtimeBusForTests(); }
  });
  test("removed workspace membership denies activity reads and authenticated bot retries", async () => {
    const input = snapshot(); await ok("POST","/hermes-platform/activity",input,f.bot.apiKey);
    const [humanMembership] = await db.select().from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId,f.workspace.id),eq(workspaceMembers.userId,f.human.user.id)));
    await db.delete(workspaceMembers).where(and(eq(workspaceMembers.workspaceId,f.workspace.id),eq(workspaceMembers.userId,f.human.user.id)));
    try { const hidden = await request("GET",`/bot-runtime/conversations/${f.dm.id}`,undefined,f.human.accessToken); expect(hidden.status).toBe(200); expect(hidden.data.activity).toEqual([]); }
    finally { await db.insert(workspaceMembers).values(humanMembership!); }
    const [botMembership] = await db.select().from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId,f.workspace.id),eq(workspaceMembers.userId,f.bot.userId)));
    await db.delete(workspaceMembers).where(and(eq(workspaceMembers.workspaceId,f.workspace.id),eq(workspaceMembers.userId,f.bot.userId)));
    try { expect((await request("POST","/hermes-platform/activity",input,f.bot.apiKey)).status).toBe(403); }
    finally { await db.insert(workspaceMembers).values(botMembership!); }
  });
  test("terminal task and worker identities cannot reopen on higher revisions", async () => {
    const input = snapshot(); await ok("POST","/hermes-platform/activity",input,f.bot.apiKey);
    const verified = {...input,eventId:crypto.randomUUID(),sequence:2,parent:{...input.parent,state:"verifying"},workers:[{...input.workers[0],state:"finished"}]};
    await ok("POST","/hermes-platform/activity",verified,f.bot.apiKey);
    expect((await request("POST","/hermes-platform/activity",{...input,eventId:crypto.randomUUID(),sequence:3},f.bot.apiKey)).status).toBe(409);
    const finished = {...verified,eventId:crypto.randomUUID(),sequence:3,parent:{...input.parent,state:"finished"}};
    await ok("POST","/hermes-platform/activity",finished,f.bot.apiKey);
    expect((await request("POST","/hermes-platform/activity",{...verified,eventId:crypto.randomUUID(),sequence:4},f.bot.apiKey)).status).toBe(409);
    const runtime = await ok("GET",`/bot-runtime/conversations/${f.dm.id}`,undefined,f.human.accessToken);
    expect(runtime.activity.find((row:any) => row.taskId === input.taskId).parent.state).toBe("finished");
  });
  test("keeps the session and origin binding immutable while accepting updates after origin retention cleanup", async () => {
    const input = snapshot(); await ok("POST","/hermes-platform/activity",input,f.bot.apiKey);
    expect((await request("POST","/hermes-platform/activity",{...input,eventId:crypto.randomUUID(),sequence:2,sessionId:"foreign-session"},f.bot.apiKey)).status).toBe(409);
    const other = await fixture();
    expect((await request("POST","/hermes-platform/activity",{...input,eventId:crypto.randomUUID(),sequence:2,originInvocationId:other.invocation.id},f.bot.apiKey)).status).toBe(409);
    await db.delete(botInvocations).where(eq(botInvocations.id,f.invocation.id));
    await ok("POST","/hermes-platform/activity",{...input,eventId:crypto.randomUUID(),sequence:2},f.bot.apiKey);
    const runtime = await ok("GET",`/bot-runtime/conversations/${f.dm.id}`,undefined,f.human.accessToken);
    expect(runtime.activity.find((row:any) => row.taskId === input.taskId)).toMatchObject({sequence:2,sessionId:input.sessionId});
    // Restore the origin fixture for independent subsequent scenarios.
    await db.insert(botInvocations).values(f.invocation);
  });
  test("full snapshots supersede missed revisions without late arrival regressing the projection", async () => {
    const input = snapshot();
    await ok("POST","/hermes-platform/activity",input,f.bot.apiKey);
    const newer = {...input,eventId:crypto.randomUUID(),sequence:3,parent:{...input.parent,state:"verifying"},workers:[{...input.workers[0],state:"finished"}]};
    await ok("POST","/hermes-platform/activity",newer,f.bot.apiKey);
    await ok("POST","/hermes-platform/activity",{...input,eventId:crypto.randomUUID(),sequence:2},f.bot.apiKey);
    const runtime = await ok("GET",`/bot-runtime/conversations/${f.dm.id}`,undefined,f.human.accessToken);
    expect(runtime.activity.find((row:any) => row.taskId === input.taskId)).toMatchObject({sequence:3,parent:newer.parent,workers:newer.workers});
  });
  test("retries identical snapshots but rejects event and sequence reuse with different content", async () => {
    const input = snapshot();
    await ok("POST","/hermes-platform/activity",input,f.bot.apiKey);
    await ok("POST","/hermes-platform/activity",input,f.bot.apiKey);
    expect((await request("POST","/hermes-platform/activity",{...input,parent:{...input.parent,state:"working"}},f.bot.apiKey)).status).toBe(409);
    expect((await request("POST","/hermes-platform/activity",{...input,eventId:crypto.randomUUID()},f.bot.apiKey)).status).toBe(409);
    expect((await request("POST","/hermes-platform/activity",{...input,taskId:crypto.randomUUID()},f.bot.apiKey)).status).toBe(409);
  });
  test("accepts completed origin without reviving its invocation and recovers its worker on read", async () => {
    const input = snapshot();
    const published = await request("POST","/hermes-platform/activity",input,f.bot.apiKey);
    expect(published.status).toBe(200);
    expect(published.data).toEqual({ok:true,taskId:input.taskId,sequence:1});
    const runtime = await ok("GET",`/bot-runtime/conversations/${f.dm.id}`,undefined,f.human.accessToken);
    expect(runtime.invocations).toEqual([]);
    expect(runtime.activity).toContainEqual(expect.objectContaining({taskId:input.taskId,conversationId:f.dm.id,threadId:null,workers:input.workers,activities:input.activities}));
    const [origin] = await db.select().from(botInvocations).where(eq(botInvocations.id,f.invocation.id));
    expect(origin!.responseJson).toEqual(f.invocation.responseJson);
    expect(origin!.completedAt).toEqual(f.invocation.completedAt);
  });
});
