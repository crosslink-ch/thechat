import { afterAll, expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import postgres from 'postgres';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Separate, already migrated disposable DB: the real worker may claim every
// pending event in its database. Never run it over another suite's fixtures.
const workerUrl=process.env.THECHAT_TENANCY_WORKER_TEST_URL;
const workerTest=workerUrl ? test : test.skip;
const original={...process.env};
let owner: ReturnType<typeof postgres>, workspaceId: string, actorId: string;
let child: ReturnType<typeof Bun.spawn> | undefined;
afterAll(async()=> {
  if(child && child.exitCode===null) {child.kill('SIGKILL');await child.exited;}
  if(owner) {
    if(workspaceId) {
      await owner`delete from event_outbox where tenant_id=${workspaceId}`;
      await owner`delete from workspaces where id=${workspaceId}`;
    }
    if(actorId) await owner`delete from users where id=${actorId}`;
    await owner.end();
    const {closeDatabaseConnections}=await import('./index');
    const {closeRealtimeBusForTests}=await import('../realtime');
    await closeDatabaseConnections();await closeRealtimeBusForTests();
  }
  for(const name of ['DATABASE_URL','DATABASE_AUTH_URL','DATABASE_WORKER_URL','DATABASE_MIGRATION_URL','REDIS_KEY_PREFIX']) {
    if(original[name]===undefined) delete process.env[name]; else process.env[name]=original[name];
  }
});

workerTest('actual maintenance worker publishes a REST-produced event without runtime/auth credentials and exits cleanly', async()=> {
  const parsed=new URL(workerUrl!);
  if(!['127.0.0.1','localhost','::1'].includes(parsed.hostname) || !parsed.pathname.endsWith('_e2e') || parsed.pathname===new URL(original.DATABASE_URL!).pathname) {
    throw new Error('Worker gate requires a separate explicit loopback disposable *_e2e database');
  }
  for(const name of ['DATABASE_URL','DATABASE_AUTH_URL','DATABASE_WORKER_URL','DATABASE_MIGRATION_URL']) {
    const url=new URL(original[name]!);url.pathname=parsed.pathname;process.env[name]=url.toString();
  }
  process.env.REDIS_KEY_PREFIX=`tenancy-worker-${crypto.randomUUID()}`;
  owner=postgres(process.env.DATABASE_MIGRATION_URL!,{max:1});
  const {authRoutes}=await import('../auth');
  const {messageRoutes}=await import('../messages');
  const app=new Elysia().use(authRoutes).use(messageRoutes);
  const registered=await app.handle(new Request('http://localhost/auth/register',{
    method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({name:'maintenance canary',email:`worker-${crypto.randomUUID()}@test.com`,password:'synthetic-worker-password-123'}),
  }));
  expect(registered.status).toBe(200);
  const registration:any=await registered.json();actorId=registration.user.id;
  workspaceId=`worker-${crypto.randomUUID()}`;
  await owner`insert into workspaces(id,name,created_by_id) values (${workspaceId},'worker canary',${actorId})`;
  await owner`insert into workspace_members(workspace_id,user_id,role) values (${workspaceId},${actorId},'owner')`;
  const [conversation]=await owner`insert into conversations(type,workspace_id) values ('group',${workspaceId}) returning id`;
  await owner`insert into conversation_participants(conversation_id,user_id) values (${conversation!.id},${actorId})`;
  const sent=await app.handle(new Request(`http://localhost/messages/${conversation!.id}`,{
    method:'POST',headers:{authorization:`Bearer ${registration.accessToken}`,'content-type':'application/json'},
    body:JSON.stringify({content:'real maintenance role durable event'}),
  }));
  expect(sent.status).toBe(200);
  const message:any=await sent.json();
  const [event]=await owner`select id,event from event_outbox where event->'payload'->>'messageId'=${message.id}`;
  expect((event!.event as any).payload.targetBotIds).toEqual([]);
  const env={...process.env};
  for(const name of ['DATABASE_URL','DATABASE_AUTH_URL','DATABASE_MIGRATION_URL']) delete env[name];
  child=Bun.spawn(['bun','run','--env-file','/dev/null',fileURLToPath(new URL('../scripts/worker.ts',import.meta.url))],{
    cwd:fileURLToPath(new URL('../../',import.meta.url)),env,stdout:'pipe',stderr:'pipe',
  });
  if(!child.stdout || typeof child.stdout==='number' || !child.stderr || typeof child.stderr==='number') throw new Error('Worker output pipes are required');
  const stdout=new Response(child.stdout).text(),stderr=new Response(child.stderr).text();
  const deadline=Date.now()+20000;
  let published=false;
  while(Date.now()<deadline && child.exitCode===null) {
    const [state]=await owner`select published_at,dead_at from event_outbox where id=${event!.id}`;
    if(state?.published_at && !state.dead_at) {published=true;break;}
    await Bun.sleep(25);
  }
  child.kill('SIGTERM');
  let timer: ReturnType<typeof setTimeout>;
  const exit=await Promise.race([child.exited,new Promise<number>(resolve=>{timer=setTimeout(()=>{child!.kill('SIGKILL');resolve(-1);},10000);})]);
  clearTimeout(timer!);
  const logs=(await stdout)+(await stderr);
  expect(published,logs).toBe(true);
  expect(exit,logs).toBe(0);
},35000);
