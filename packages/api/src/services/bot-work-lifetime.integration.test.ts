import { afterAll, expect, test } from 'bun:test';
import { eq, inArray, sql } from 'drizzle-orm';
import crypto from 'node:crypto';
import { db as fixture } from '../db/testing';
import { db, withDatabaseContext, withWorkerDatabaseContext } from '../db';
import { users, bots, workspaces, workspaceMembers, conversations, conversationParticipants, messages, botInvocations, botWorkspaceInstallations } from '../db/schema';
import { __botRuntimeInternalsForTests, claimHermesPlatformEvents, completeHermesPlatformInvocationSilently, cancelHermesPlatformInvocation, publishHermesPlatformMessage, publishHermesPlatformProgress, startBotWorker, closeBotRuntime } from './bot-runtime';
import { createLocalBotProgressStoreForTests, setBotProgressStoreForTests, closeBotProgressStoreForTests } from './bot-progress-store';
import { BullMqAsyncBus } from '../async';
import { Queue } from 'bullmq';
import { createBullMqConnection } from '../async/bullmq';
import { toBullMqQueueName, toBullMqJobId } from '../async/transport';
import { admitWorkspaceWork } from './workspace-resource-budgets';
import { BOT_QUEUE_NAME, BOT_INVOKE_JOB_NAME, HERMES_WEBHOOK_DELIVERY_JOB_NAME } from './bot-runtime';

const workspaceIds: string[] = [], userIds: string[] = [];
afterAll(async () => {
  await closeBotRuntime();
  await closeBotProgressStoreForTests();
  if (workspaceIds.length) await fixture.delete(workspaces).where(inArray(workspaces.id, workspaceIds));
  if (userIds.length) await fixture.delete(users).where(inArray(users.id, userIds));
});
async function setup() {
  const [human, botUser] = await fixture.insert(users).values([{name:'Budget human'}, {name:'Budget Hermes',type:'bot'}]).returning();
  userIds.push(human!.id, botUser!.id);
  const [bot] = await fixture.insert(bots).values({userId:botUser!.id,ownerId:human!.id,kind:'hermes',webhookSecret:'synthetic-budget'}).returning();
  const wid = `lifetime-${crypto.randomUUID()}`;
  workspaceIds.push(wid);
  await fixture.insert(workspaces).values({id:wid,name:'Budget lifetime'});
  await fixture.insert(workspaceMembers).values([{workspaceId:wid,userId:human!.id,role:'owner'}, {workspaceId:wid,userId:botUser!.id}]);
  await fixture.insert(botWorkspaceInstallations).values({workspaceId:wid,botId:bot!.id,enabled:true,channelScope:'all',sharedRuntimeConsent:true});
  const [conversation] = await fixture.insert(conversations).values({workspaceId:wid,type:'group'}).returning();
  await fixture.insert(conversationParticipants).values([{conversationId:conversation!.id,userId:human!.id}, {conversationId:conversation!.id,userId:botUser!.id}]);
  await fixture.execute(sql`insert into workspace_resource_limits values (${wid},100000,10,10,1,2)`);
  const ids: string[] = [];
  for (let i=0; i<3; i++) {
    const [message] = await fixture.insert(messages).values({conversationId:conversation!.id,senderId:human!.id,content:'task'}).returning();
    const [invocation] = await fixture.insert(botInvocations).values({conversationId:conversation!.id,botId:bot!.id,triggerMessageId:message!.id,adapterKind:'hermes',status:'queued',requestJson:{installationRevision:1}}).returning();
    ids.push(invocation!.id);
  }
  return {wid,bot:bot!,conversation:conversation!,ids,botUser:botUser!};
}
type Fixture = Awaited<ReturnType<typeof setup>>;
const asBot = <T>(f:Fixture, operation:()=>Promise<T>) => withDatabaseContext({actorId:f.botUser.id,scope:'actor'},operation);

for(const kind of ['webhook','hermes'] as const) test(`actual ${kind} worker keeps durable capacity deferral alive beyond finite retries`,async()=>{
  const a=await setup();let release!:()=>void, entered!:()=>void,calls=0;
  const gate=new Promise<void>(r=>release=r),two=new Promise<void>(r=>entered=r);
  const server=Bun.serve({port:0,hostname:'127.0.0.1',async fetch(){calls++;if(calls===2)entered();await gate;return new Response('{}');}});
  const url=`http://127.0.0.1:${server.port}`;
  const bus=new BullMqAsyncBus();const queue=new Queue(toBullMqQueueName(BOT_QUEUE_NAME),{connection:createBullMqConnection(),prefix:process.env.REDIS_KEY_PREFIX??'thechat'});
  const jobIds=a.ids.map(id=>`review-admission-${id}`);
  try{
    await fixture.update(bots).set({kind,webhookUrl:url}).where(eq(bots.id,a.bot.id));
    await fixture.update(botWorkspaceInstallations).set({approvedEndpointUrl:url}).where(eq(botWorkspaceInstallations.workspaceId,a.wid));
    await fixture.update(botInvocations).set({adapterKind:kind}).where(inArray(botInvocations.id,a.ids));
    // Production getOrCreateInvocation commits admission before queue delivery.
    for(const id of a.ids) await withWorkerDatabaseContext(()=>db.transaction(tx=>admitWorkspaceWork(tx,a.wid,'bot',id)));
    await startBotWorker({concurrency:4});
    for(let n=0;n<a.ids.length;n++) await bus.enqueue({queue:BOT_QUEUE_NAME,name:kind==='webhook'?BOT_INVOKE_JOB_NAME:HERMES_WEBHOOK_DELIVERY_JOB_NAME,jobId:jobIds[n]!,attempts:3,backoff:{type:'fixed',delay:25},message:{id:crypto.randomUUID(),type:'review.actual-admission',version:1,aggregate:{type:'bot_invocation',id:a.ids[n]!},actor:{type:'system',id:'thechat'},tenant:{workspaceId:a.wid},correlationId:crypto.randomUUID(),occurredAt:new Date().toISOString(),payload:{invocationId:a.ids[n]!}}});
    await Promise.race([two,Bun.sleep(10000).then(()=>{throw new Error('No actual worker dispatch');})]);
    await Bun.sleep(2500);
    const pending=await queue.getJob(toBullMqJobId(jobIds[2]!));
    expect(await pending!.getState()).toBe('delayed');expect(pending!.attemptsMade).toBe(0);expect(calls).toBe(2);
    release();
    if(kind==='hermes'){
      const first=await fixture.select().from(botInvocations).where(inArray(botInvocations.id,a.ids.slice(0,2)));
      for(const invocation of first) await asBot(a,()=>completeHermesPlatformInvocationSilently({authenticatedBotId:a.bot.id,invocationId:invocation.id,workToken:invocation.requestJson?.workToken as string}));
    }
    const deadline=Date.now()+10000;while(calls<3 && Date.now()<deadline)await Bun.sleep(50);
    expect(calls).toBe(3);
  }finally{release();await closeBotRuntime();await bus.close();await queue.close();server.stop(true);}
},30000);

test('two long remote A runs saturate A while B progresses; terminal and cancel release admission', async () => {
  const a=await setup(), b=await setup();
  const events=await asBot(a,()=>claimHermesPlatformEvents(a.bot.id,10));
  expect(events).toHaveLength(2);
  expect(await asBot(b,()=>claimHermesPlatformEvents(b.bot.id,10))).toHaveLength(2);
  expect(await asBot(a,()=>claimHermesPlatformEvents(a.bot.id,10))).toHaveLength(0);
  expect(await fixture.execute(sql`select 1 from workspace_work where workspace_id=${a.wid} and state='running'`)).toHaveLength(2);
  await asBot(a,()=>completeHermesPlatformInvocationSilently({authenticatedBotId:a.bot.id,invocationId:events[0]!.id,workToken:events[0]!.workToken}));
  expect(await asBot(a,()=>claimHermesPlatformEvents(a.bot.id,10))).toHaveLength(1);
  await asBot(a,()=>cancelHermesPlatformInvocation({authenticatedBotId:a.bot.id,invocationId:events[1]!.id,workToken:events[1]!.workToken}));
  expect(await fixture.execute(sql`select 1 from workspace_work where workspace_id=${a.wid} and state='running'`)).toHaveLength(1);
});

test('real Hermes webhook carries its live remote epoch through terminal completion', async () => {
  const a=await setup();let received:{id:string;workToken?:string}|undefined;
  const server=Bun.serve({port:0,hostname:'127.0.0.1',async fetch(request){received=(await request.json() as {event:{id:string;workToken?:string}}).event;return new Response('ok');}});
  const url=`http://127.0.0.1:${server.port}`;
  await fixture.update(bots).set({webhookUrl:url}).where(eq(bots.id,a.bot.id));
  await fixture.update(botWorkspaceInstallations).set({approvedEndpointUrl:url}).where(eq(botWorkspaceInstallations.workspaceId,a.wid));
  try {
    await withWorkerDatabaseContext(()=>__botRuntimeInternalsForTests.deliverHermesPlatformWebhookInvocation(a.ids[0]!));
    expect(received?.workToken).toBeString();
    const [work]=await fixture.execute<{state:string;lease_token:string}>(sql`select state,lease_token from workspace_work where workspace_id=${a.wid} and idempotency_key=${a.ids[0]!}`);
    expect(work!.state).toBe('running');expect(work!.lease_token).toBe(received!.workToken!);
    await asBot(a,()=>completeHermesPlatformInvocationSilently({authenticatedBotId:a.bot.id,invocationId:a.ids[0]!,workToken:received!.workToken}));
    const [settled]=await fixture.execute<{state:string}>(sql`select state from workspace_work where workspace_id=${a.wid} and idempotency_key=${a.ids[0]!}`);
    expect(settled!.state).toBe('completed');
  } finally {server.stop(true);}
});

test('the actual signer refuses an expired remote epoch before outbound admission',async()=>{
  const a=await setup();const [event]=await asBot(a,()=>claimHermesPlatformEvents(a.bot.id,10));
  const sign=()=>withWorkerDatabaseContext(()=>db.execute<{signature:string|null}>(sql`select public.thechat_sign_invocation(${event!.id}::uuid,${JSON.stringify({type:'thechat.hermes_platform.event',event})},${Math.floor(Date.now()/1000)}::bigint) as signature`));
  expect(typeof (await sign())[0]!.signature==='string').toBe(true);
  await fixture.execute(sql`update workspace_work set lease_until=clock_timestamp()-interval '1 second' where workspace_id=${a.wid} and kind='bot' and idempotency_key=${event!.id}`);
  expect((await sign())[0]!.signature===null).toBe(true);
});

test('admissible Hermes work without a consumer still times out and releases its pending ledger',async()=>{
  const a=await setup();
  await withWorkerDatabaseContext(()=>db.transaction(tx=>admitWorkspaceWork(tx,a.wid,'bot',a.ids[0]!)));
  const old=new Date(Date.now()-600000);
  await fixture.update(botInvocations).set({createdAt:old}).where(eq(botInvocations.id,a.ids[0]!));
  await fixture.execute(sql`update workspace_work set created_at=${old.toISOString()}::timestamptz,updated_at=${old.toISOString()}::timestamptz where workspace_id=${a.wid} and idempotency_key=${a.ids[0]!}`);
  await withWorkerDatabaseContext(()=>__botRuntimeInternalsForTests.failQueuedHermesDispatch(a.ids[0]!,new Error('No consumer')));
  const [invocation]=await fixture.select().from(botInvocations).where(eq(botInvocations.id,a.ids[0]!));
  const [work]=await fixture.execute<{state:string}>(sql`select state from workspace_work where workspace_id=${a.wid} and idempotency_key=${a.ids[0]!}`);
  expect(invocation!.status).toBe('failed');expect(work!.state).toBe('cancelled');
});

test('capacity-waiting Hermes work is not a missing-consumer timeout',async()=>{
  const a=await setup();
  await fixture.execute(sql`update workspace_resource_limits set concurrent_bot=1 where workspace_id=${a.wid}`);
  const [first]=await asBot(a,()=>claimHermesPlatformEvents(a.bot.id,1));
  await withWorkerDatabaseContext(()=>db.transaction(tx=>admitWorkspaceWork(tx,a.wid,'bot',a.ids[1]!)));
  await fixture.update(botInvocations).set({createdAt:new Date(Date.now()-600000)}).where(eq(botInvocations.id,a.ids[1]!));
  await fixture.execute(sql`update workspace_work set created_at=now()-interval '11 minutes' where workspace_id=${a.wid} and idempotency_key=${first!.id}`);
  await fixture.execute(sql`update workspace_work set created_at=now()-interval '10 minutes',updated_at=now()-interval '10 minutes' where workspace_id=${a.wid} and idempotency_key=${a.ids[1]!}`);
  await withWorkerDatabaseContext(()=>__botRuntimeInternalsForTests.failQueuedHermesDispatch(a.ids[1]!,new Error('No consumer')));
  const [pending]=await fixture.select().from(botInvocations).where(eq(botInvocations.id,a.ids[1]!));
  expect(pending!.status).toBe('queued');
  await asBot(a,()=>completeHermesPlatformInvocationSilently({authenticatedBotId:a.bot.id,invocationId:first!.id,workToken:first!.workToken}));
  const next=await asBot(a,()=>claimHermesPlatformEvents(a.bot.id,1));expect(next[0]?.id).toBe(a.ids[1]!);
});

test('regular webhook concurrency spans the real HTTP lifetime and renews leases', async () => {
  const a=await setup();
  let release!:()=>void, entered!:()=>void, calls=0;
  const gate=new Promise<void>(resolve=>release=resolve), two=new Promise<void>(resolve=>entered=resolve);
  const server=Bun.serve({port:0,hostname:'127.0.0.1',async fetch(){calls++;if(calls===2)entered();await gate;return new Response('{}');}});
  const url=`http://127.0.0.1:${server.port}`;
  await fixture.update(bots).set({kind:'webhook',webhookUrl:url}).where(eq(bots.id,a.bot.id));
  await fixture.update(botWorkspaceInstallations).set({approvedEndpointUrl:url}).where(eq(botWorkspaceInstallations.workspaceId,a.wid));
  await fixture.update(botInvocations).set({adapterKind:'webhook'}).where(inArray(botInvocations.id,a.ids));
  const previous=process.env.WORKSPACE_WORK_LEASE_SECONDS;
  process.env.WORKSPACE_WORK_LEASE_SECONDS='1';
  const run=(id:string)=>withWorkerDatabaseContext(()=>__botRuntimeInternalsForTests.handleQueuedBotInvocation(id,{async setProgress(){}}));
  const outcomes=Promise.allSettled([run(a.ids[0]!),run(a.ids[1]!)]);
  try {
    await Promise.race([two,outcomes.then(result=>{throw new Error(JSON.stringify(result.map(r=>r.status==='rejected'?String(r.reason):'unexpected completion')));})]);
    await Bun.sleep(1250);
    expect(await fixture.execute(sql`select 1 from workspace_work where workspace_id=${a.wid} and state='running' and lease_until>now()`)).toHaveLength(2);
    await expect(run(a.ids[2]!)).rejects.toMatchObject({status:429});
    expect(calls).toBe(2);
  } finally {
    release();await outcomes;server.stop(true);
    if(previous===undefined)delete process.env.WORKSPACE_WORK_LEASE_SECONDS;else process.env.WORKSPACE_WORK_LEASE_SECONDS=previous;
  }
  expect((await outcomes).map(outcome=>outcome.status)).toEqual(['fulfilled','fulfilled']);
  expect(await fixture.execute(sql`select 1 from workspace_work where workspace_id=${a.wid} and state='running'`)).toHaveLength(0);
});

test('canonical cancellation releases its durable lease and denies stale publishers', async () => {
  const a=await setup();const [event]=await asBot(a,()=>claimHermesPlatformEvents(a.bot.id,1));
  await fixture.update(botInvocations).set({status:'cancelled'}).where(eq(botInvocations.id,event!.id));
  const [work]=await fixture.execute<{state:string}>(sql`select state from workspace_work where workspace_id=${a.wid} and idempotency_key=${event!.id}`);
  expect(work!.state).toBe('cancelled');
  await expect(asBot(a,()=>publishHermesPlatformMessage({authenticatedBotId:a.bot.id,invocationId:event!.id,content:'stale after cancellation',workToken:event!.workToken}))).rejects.toMatchObject({status:409});
});

test('missing, forged and expired remote tokens fence callbacks before canonical writes', async () => {
  const a=await setup();const [event]=await asBot(a,()=>claimHermesPlatformEvents(a.bot.id,1));
  for(const workToken of [undefined,crypto.randomUUID()]) {
    await expect(asBot(a,()=>publishHermesPlatformMessage({authenticatedBotId:a.bot.id,invocationId:event!.id,content:'late',workToken}))).rejects.toMatchObject({status:409});
  }
  await fixture.execute(sql`update workspace_work set lease_until=now()-interval '1 second' where workspace_id=${a.wid}`);
  await expect(asBot(a,()=>publishHermesPlatformMessage({authenticatedBotId:a.bot.id,invocationId:event!.id,content:'late',workToken:event!.workToken}))).rejects.toMatchObject({status:409});
  expect(await fixture.select().from(messages).where(eq(messages.content,'late'))).toHaveLength(0);
});

test('lease expiry while progress storage is paused prevents late publication and clears transient state', async () => {
  const a=await setup();const [event]=await asBot(a,()=>claimHermesPlatformEvents(a.bot.id,1));
  const store=createLocalBotProgressStoreForTests();
  const append=store.append.bind(store);
  store.append=async input=>{
    await fixture.execute(sql`update workspace_work set lease_until=now()-interval '1 second' where workspace_id=${a.wid}`);
    return append(input);
  };
  await setBotProgressStoreForTests(store);
  await expect(asBot(a,()=>publishHermesPlatformProgress({authenticatedBotId:a.bot.id,invocationId:event!.id,workToken:event!.workToken,type:'tool.started'}))).rejects.toMatchObject({status:409});
  expect(await store.listForConversation(a.conversation.id)).toHaveLength(0);
});

test('polling after remote expiry terminalizes dead epochs instead of replaying them', async () => {
  const a=await setup();
  const events=await asBot(a,()=>claimHermesPlatformEvents(a.bot.id,10));
  await fixture.execute(sql`update workspace_work set lease_until=now()-interval '1 second' where workspace_id=${a.wid}`);
  const next=await asBot(a,()=>claimHermesPlatformEvents(a.bot.id,10));
  expect(next).toHaveLength(1);
  const expired=await fixture.select().from(botInvocations).where(inArray(botInvocations.id,events.map(event=>event.id)));
  expect(expired.map(invocation=>invocation.status)).toEqual(['failed','failed']);
});

test('real bot worker startup recovers dead remote runs without redispatching uncertain external work', async () => {
  const a=await setup();const [event]=await asBot(a,()=>claimHermesPlatformEvents(a.bot.id,1));
  await fixture.execute(sql`update workspace_work set lease_until=now()-interval '1 second' where workspace_id=${a.wid}`);
  try {
    await startBotWorker();
    const [invocation]=await fixture.select().from(botInvocations).where(eq(botInvocations.id,event!.id));
    expect(invocation!.status).toBe('failed');
    expect(invocation!.error).toContain('external work may still exist');
    const [work]=await fixture.execute<{state:string}>(sql`select state from workspace_work where workspace_id=${a.wid} and idempotency_key=${event!.id}`);
    expect(work!.state).toBe('cancelled');
  } finally {await closeBotRuntime();}
});
