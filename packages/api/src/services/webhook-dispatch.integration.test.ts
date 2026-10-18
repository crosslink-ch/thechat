import { withDatabaseContext, withWorkerDatabaseContext } from '../db';
import { sql } from 'drizzle-orm';
import { withIndependentActorDatabaseContext } from '../db/context';
import { afterEach, expect, test, spyOn } from 'bun:test';
import { eq, inArray } from 'drizzle-orm';
import crypto from 'node:crypto';
import { db as fixtures } from '../db/testing';
import { users, workspaces, workspaceMembers, conversationParticipants, bots, conversations, messages, botInvocations, attachments, messageAttachments } from '../db/schema';
import { createWorkspace } from './workspaces';
import { addOwnedBotToWorkspace } from './bot-workspace-memberships';
import { removeBotFromWorkspace, updateAuthenticatedBotWebhook } from './bots';
import { updateBotInstallation } from './bot-installation-access';
import { __botRuntimeInternalsForTests as runtime, claimHermesPlatformEvents, publishHermesPlatformProgress, submitHermesPlatformInteraction, submitHermesPlatformVaultUnlock } from './bot-runtime';

const userIds:string[]=[], workspaceIds:string[]=[];
let server:ReturnType<typeof Bun.serve>|undefined;
afterEach(async()=>{
  server?.stop(true);server=undefined;
  if(workspaceIds.length)await fixtures.delete(workspaces).where(inArray(workspaces.id,workspaceIds.splice(0)));
  if(userIds.length)await fixtures.delete(users).where(inArray(users.id,userIds.splice(0)));
});
async function fixture(kind:'webhook'|'hermes') {
  const [owner,botUser]=await fixtures.insert(users).values([{name:'Dispatch owner'},{name:'Dispatch bot',type:'bot'}]).returning();
  userIds.push(owner!.id,botUser!.id);
  const workspace=await withDatabaseContext({actorId:owner!.id,scope:'actor'},()=>createWorkspace('Dispatch synthetic',owner!.id));
  workspaceIds.push(workspace.id);
  const [bot]=await fixtures.insert(bots).values({userId:botUser!.id,ownerId:owner!.id,kind,webhookUrl:`http://127.0.0.1:${server!.port}/hook`,webhookSecret:'synthetic-secret'}).returning();
  await withDatabaseContext({actorId:owner!.id,scope:'actor'},()=>addOwnedBotToWorkspace(bot!.id,workspace.id,owner!.id));
  const [channel]=await fixtures.select().from(conversations).where(eq(conversations.workspaceId,workspace.id));
  const [message]=await fixtures.insert(messages).values({senderId:owner!.id,conversationId:channel!.id,content:'synthetic trigger'}).returning();
  const [invocation]=await fixtures.insert(botInvocations).values({botId:bot!.id,conversationId:channel!.id,triggerMessageId:message!.id,adapterKind:kind,status:'queued',requestJson:{installationRevision:1}}).returning();
  return {owner:owner!,botUser:botUser!,bot:bot!,workspace,channel:channel!,message:message!,invocation:invocation!};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
const asBot=<T>(f:Fixture,operation:()=>Promise<T>)=>withDatabaseContext({actorId:f.botUser.id,scope:'actor'},operation);
const asOwner=<T>(f:Fixture,operation:()=>Promise<T>)=>withIndependentActorDatabaseContext({actorId:f.owner.id,scope:'actor'},operation);
const revoke=(f:Fixture,enabled=false)=>asOwner(f,()=>updateBotInstallation(f.workspace.id,f.bot.id,f.owner.id,{enabled,channelScope:'all',conversationIds:[],attachmentAccess:false,sharedRuntimeConsent:true,expectedRevision:1}));
async function claim(f:Fixture){const [event]=await asBot(f,()=>claimHermesPlatformEvents(f.bot.id,1));expect(event).toBeDefined();return event!;}

test('an authorized non-requester participant retains non-secret interaction authority',async()=>{
  let calls=0;server=Bun.serve({hostname:'127.0.0.1',port:0,fetch(){calls++;return Response.json({ok:true,duplicate:false});}});
  const f=await fixture('hermes'),event=await claim(f);
  const [other]=await fixtures.insert(users).values({name:'Other interaction participant'}).returning();userIds.push(other!.id);
  await fixtures.insert(workspaceMembers).values({workspaceId:f.workspace.id,userId:other!.id,role:'member'});
  await fixtures.insert(conversationParticipants).values({conversationId:f.channel.id,userId:other!.id});
  const progress=await asBot(f,()=>publishHermesPlatformProgress({authenticatedBotId:f.bot.id,invocationId:event.id,workToken:event.workToken,type:'approval.request',status:'waiting',payload:{requestId:crypto.randomUUID(),sessionKey:'synthetic-other-member',command:'true',description:'Synthetic operation',choices:['once','deny']}}));
  const result=await withIndependentActorDatabaseContext({actorId:other!.id,scope:'actor'},()=>submitHermesPlatformInteraction({userId:other!.id,userType:'human',invocationId:event.id,eventId:progress.event!.id,response:'once'}));
  expect(result.ok).toBe(true);expect(calls).toBe(1);
});

test('human interaction relay rechecks installation immediately before its outbound fetch',async()=>{
  let calls=0;server=Bun.serve({hostname:'127.0.0.1',port:0,fetch(){calls++;return Response.json({ok:true});}});
  const f=await fixture('hermes'),event=await claim(f);
  const progress=await asBot(f,()=>publishHermesPlatformProgress({authenticatedBotId:f.bot.id,invocationId:event.id,workToken:event.workToken,type:'approval.request',status:'waiting',payload:{requestId:'synthetic-approval',sessionKey:'synthetic-session',command:'true',description:'Synthetic operation',choices:['once','deny']}}));
  await expect(asOwner(f,()=>submitHermesPlatformInteraction({userId:f.owner.id,userType:'human',invocationId:event.id,eventId:progress.event!.id,response:'once'},{beforeDispatch:async()=>{await revoke(f);}}))).rejects.toMatchObject({status:409});
  expect(calls).toBe(0);
});

test('polling claim intersects captured attachment metadata with current global safety',async()=>{
  server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>Response.json({ok:true})});
  const f=await fixture('hermes');
  await fixtures.update(bots).set({attachmentAccess:true}).where(eq(bots.id,f.bot.id));
  await asOwner(f,()=>updateBotInstallation(f.workspace.id,f.bot.id,f.owner.id,{enabled:true,channelScope:'all',conversationIds:[],attachmentAccess:true,sharedRuntimeConsent:true,expectedRevision:1}));
  await fixtures.update(botInvocations).set({requestJson:{installationRevision:2}}).where(eq(botInvocations.id,f.invocation.id));
  const [file]=await fixtures.insert(attachments).values({conversationId:f.channel.id,uploaderId:f.owner.id,fileName:'synthetic.txt',declaredMediaType:'text/plain',verifiedMediaType:'text/plain',declaredSizeBytes:1,declaredChecksumSha256:'a'.repeat(64),verifiedSizeBytes:1,status:'attached',quarantineKey:'synthetic/pending',cleanKey:'synthetic/clean',cleanVersionId:'synthetic-v1',uploadExpiresAt:new Date(),expiresAt:new Date()}).returning();
  await fixtures.insert(messageAttachments).values({messageId:f.message.id,attachmentId:file!.id,position:0});
  let captured=false;
  const event=await asBot(f,()=>runtime.claimHermesPlatformInvocation(f.invocation.id,'polling',async()=>{
    captured=true;
    await fixtures.update(bots).set({attachmentAccess:false}).where(eq(bots.id,f.bot.id));
  }));
  expect(captured).toBe(true);expect(event).not.toBeNull();expect(event!.attachments).toHaveLength(0);
  const [current]=await fixtures.select().from(botInvocations).where(eq(botInvocations.id,f.invocation.id));
  expect(current!.requestJson?.attachments).toEqual([]);
});

test('polling claim denies a grant revision revoked after payload capture',async()=>{
  server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>Response.json({ok:true})});
  const f=await fixture('hermes');let captured=false;
  const event=await asBot(f,()=>runtime.claimHermesPlatformInvocation(f.invocation.id,'polling',async()=>{captured=true;await revoke(f,true);}));
  expect(captured).toBe(true);expect(event).toBeNull();
});

test('refused ordinary dispatch terminalizes canonical invocation and its ledger together',async()=>{
  let calls=0;server=Bun.serve({hostname:'127.0.0.1',port:0,fetch(){calls++;return Response.json({ok:true});}});
  const f=await fixture('webhook');
  await withWorkerDatabaseContext(()=>runtime.handleQueuedBotInvocation(f.invocation.id,{async setProgress(progress:number){
    if(progress===15) await asBot(f,()=>updateAuthenticatedBotWebhook(f.botUser.id,`http://127.0.0.1:${server!.port}/changed`));
  }}));
  expect(calls).toBe(0);
  const [invocation]=await fixtures.select().from(botInvocations).where(eq(botInvocations.id,f.invocation.id));
  const [work]=await fixtures.execute<{state:string;lease_token:string|null}>(sql`select state,lease_token from workspace_work where workspace_id=${f.workspace.id} and idempotency_key=${f.invocation.id}`);
  expect(invocation!.status).toBe('cancelled');expect(work!.state).toBe('cancelled');expect(work!.lease_token).toBeNull();
});

test('endpoint revision changing after capture cannot dispatch or retry without workspace approval',async()=>{
  let calls=0;server=Bun.serve({hostname:'127.0.0.1',port:0,fetch(){calls++;return new Response('ok');}});
  const f=await fixture('hermes');
  await withWorkerDatabaseContext(()=>runtime.deliverHermesPlatformWebhookInvocation(f.invocation.id,{beforeDispatch:async()=>{
    await asBot(f,()=>updateAuthenticatedBotWebhook(f.botUser.id,`http://127.0.0.1:${server!.port}/changed`));
  }}));
  await withWorkerDatabaseContext(()=>runtime.deliverHermesPlatformWebhookInvocation(f.invocation.id));
  expect(calls).toBe(0);
});

test('Hermes grant revision changing after claim fences the captured body and its retry',async()=>{
  let calls=0;server=Bun.serve({hostname:'127.0.0.1',port:0,fetch(){calls++;return new Response('ok');}});
  const f=await fixture('hermes');
  await withWorkerDatabaseContext(()=>runtime.deliverHermesPlatformWebhookInvocation(f.invocation.id,{beforeDispatch:async()=>{await revoke(f,true);}}));
  await withWorkerDatabaseContext(()=>runtime.deliverHermesPlatformWebhookInvocation(f.invocation.id));
  expect(calls).toBe(0);
});

test('vault relay cannot use a grant revoked after encrypted context capture',async()=>{
  let calls=0;server=Bun.serve({hostname:'127.0.0.1',port:0,fetch(){calls++;return Response.json({ok:true,duplicate:false});}});
  const f=await fixture('hermes'),event=await claim(f);
  const key=crypto.generateKeyPairSync('rsa',{modulusLength:3072}).publicKey;
  const progress=await asBot(f,()=>publishHermesPlatformProgress({authenticatedBotId:f.bot.id,invocationId:event.id,workToken:event.workToken,type:'vault.unlock.request',payload:{version:2,requestId:crypto.randomUUID(),sessionKey:'synthetic-vault-session',profileId:'synthetic-profile',backend:'bitwarden',requesterUserId:f.owner.id,nonce:crypto.randomBytes(32).toString('base64url'),expiresAt:Date.now()+120000,algorithm:'RSA-OAEP-3072-SHA256+A256GCM',publicKeySpkiB64:key.export({format:'der',type:'spki'}).toString('base64')}}));
  await expect(asOwner(f,()=>submitHermesPlatformVaultUnlock({userId:f.owner.id,userType:'human',invocationId:event.id,eventId:progress.event!.id,response:{version:2,action:'cancel'}},{beforeDispatch:async()=>{await revoke(f);}}))).rejects.toMatchObject({status:409});
  expect(calls).toBe(0);
});

test('webhook cancellation between worker capture and dispatch produces zero external calls',async()=>{
  let calls=0;server=Bun.serve({hostname:'127.0.0.1',port:0,fetch(){calls++;return new Response('ok');}});
  const f=await fixture('webhook');
  await expect(withWorkerDatabaseContext(()=>runtime.handleQueuedBotInvocation(f.invocation.id,{async setProgress(progress:number){
    if(progress===15)await fixtures.update(botInvocations).set({status:'cancelled'}).where(eq(botInvocations.id,f.invocation.id));
  }}))).rejects.toMatchObject({status:409});
  expect(calls).toBe(0);
  const [invocation]=await fixtures.select().from(botInvocations).where(eq(botInvocations.id,f.invocation.id));
  expect(invocation!.status).toBe('cancelled');
});

test('webhook refuses redirects instead of forwarding tenant payload',async()=>{
  let redirected=0,entered=0;server=Bun.serve({hostname:'127.0.0.1',port:0,fetch(request){
    if(new URL(request.url).pathname==='/hook'){entered++;return new Response(null,{status:307,headers:{location:'/exfiltrate'}});}
    redirected++;return new Response('ok');
  }});
  const f=await fixture('webhook');
  const error=await withWorkerDatabaseContext(()=>runtime.handleQueuedBotInvocation(f.invocation.id,{async setProgress(){}})).then(()=>null,error=>error);
  expect(entered).toBe(1);expect(redirected).toBe(0);expect(error).not.toBeNull();
});

test('outbound webhook request is aborted within configured bounded timeout',async()=>{
  server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(){await Bun.sleep(800);return new Response('late');}});
  const f=await fixture('webhook'),previous=process.env.BOT_WEBHOOK_TIMEOUT_MS;
  process.env.BOT_WEBHOOK_TIMEOUT_MS='50';
  const realFetch=globalThis.fetch;let elapsed=Infinity,signal:AbortSignal|undefined,calls=0;
  const observed=spyOn(globalThis,'fetch').mockImplementation((async(url:any,options:any)=>{
    calls++;signal=options.signal;const started=Date.now();try{return await realFetch(url,options);}finally{elapsed=Date.now()-started;}
  }) as typeof fetch);
  try {
    const error=await withWorkerDatabaseContext(()=>runtime.handleQueuedBotInvocation(f.invocation.id,{async setProgress(){}})).then(()=>null,error=>error);
    expect(error).not.toBeNull();expect(calls).toBe(1);expect(signal?.aborted).toBe(true);expect(elapsed).toBeLessThan(650);
  } finally {
    observed.mockRestore();if(previous===undefined)delete process.env.BOT_WEBHOOK_TIMEOUT_MS;else process.env.BOT_WEBHOOK_TIMEOUT_MS=previous;
  }
});

test('Hermes removal immediately before outbound fetch produces zero calls, including retry',async()=>{
  let calls=0;server=Bun.serve({hostname:'127.0.0.1',port:0,fetch(){calls++;return new Response('ok');}});
  const f=await fixture('hermes');
  await withWorkerDatabaseContext(()=>runtime.deliverHermesPlatformWebhookInvocation(f.invocation.id,{beforeDispatch:async()=>{
    await asOwner(f,()=>removeBotFromWorkspace(f.bot.id,f.workspace.id,f.owner.id));
  }}));
  await withWorkerDatabaseContext(()=>runtime.deliverHermesPlatformWebhookInvocation(f.invocation.id));
  expect(calls).toBe(0);
});
