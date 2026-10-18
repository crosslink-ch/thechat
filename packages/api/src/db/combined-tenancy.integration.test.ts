import { afterAll, beforeAll, expect, test } from 'bun:test';
import crypto from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { db, assertDatabaseSafety, closeDatabaseConnections, withDatabaseContext, withWorkerDatabaseContext } from './index';
import { users, workspaces, workspaceMembers, conversations, bots, botWorkspaceInstallations, workspaceResourceLimits, workspaceWork, workspaceAttachmentCharges, attachmentObjectCleanup } from './schema';
import { createWorkspace } from '../services/workspaces';
import { withAuthorizedRealtimeEvent } from '../ws/resource-authorization';
import { requestBotForWorkspace, acceptBotWorkspaceInvite, listOwnedPendingBotWorkspaceInvites } from '../services/bot-workspace-memberships';
import { requireBotInstallationAccess } from '../services/bot-installation-access';
import { removeBotFromWorkspace } from '../services/bots';
import { claimHermesPlatformEvents, completeHermesPlatformInvocationSilently } from '../services/bot-runtime';
import { sendMessage } from '../services/messages';
import { createChatMessageSentHandler } from '../events/message-handler';
const owner=postgres(process.env.DATABASE_MIGRATION_URL!,{max:2});
const actor=crypto.randomUUID(), other=crypto.randomUUID(), botUser=crypto.randomUUID(), botId=crypto.randomUUID();
const wid=`combined-${crypto.randomUUID()}`, foreign=`combined-${crypto.randomUUID()}`;let channel:string;const created:string[]=[];
const asActor=<T>(id:string,operation:()=>Promise<T>)=>withDatabaseContext({actorId:id,scope:'actor'},operation);
beforeAll(async()=>{
 await owner`insert into users(id,name,type) values (${actor},'A','human'),(${other},'B','human'),(${botUser},'foreign bot','bot')`;
 await owner`insert into bots(id,user_id,owner_id,webhook_secret) values (${botId},${botUser},${other},'private-must-not-leak')`;
 for(const [w,u] of [[wid,actor],[foreign,other]]) {await owner`insert into workspaces(id,name) values (${w},'combined')`;await owner`insert into workspace_members(workspace_id,user_id,role) values (${w},${u},'owner')`;}
 const [c]=await owner`insert into conversations(workspace_id,type) values (${wid},'group') returning id`;channel=c!.id;
});
afterAll(async()=>{for(const w of [wid,foreign,...created])await owner`delete from workspaces where id=${w}`;for(const u of [actor,other,botUser])await owner`delete from users where id=${u}`;await owner.end();await closeDatabaseConnections();});
test('combined startup enforces exact installation and lifecycle policies',async()=>{
 await assertDatabaseSafety();
 const [acl]=await owner`select count(*)::int n from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'thechat_%' and exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where a.grantee=0 and a.privilege_type='EXECUTE')`;
 expect(acl!.n).toBe(0);
});
test('restricted actor bootstraps workspace owner General and participant atomically',async()=>{
 const result=await asActor(actor,()=>createWorkspace('Combined bootstrap',actor));created.push(result.id);
 const [n]=await owner`select count(*)::int n from conversation_participants p join conversations c on c.id=p.conversation_id join workspace_members m on m.workspace_id=c.workspace_id and m.user_id=p.user_id where c.workspace_id=${result.id} and m.role='owner' and c.name='general'`;expect(n!.n).toBe(1);
 await expect(asActor(actor,()=>createWorkspace('Must roll back',actor,{afterOwnerInserted:async()=>{throw new Error('rollback-bootstrap');}}))).rejects.toThrow('rollback-bootstrap');
 expect((await owner`select 1 from workspaces where name='Must roll back'`).length).toBe(0);
});
test('RLS hidden private bot row cannot turn bot installation absence into human permission',async()=>{
 await expect(asActor(actor,()=>requireBotInstallationAccess(db,channel,botUser))).rejects.toThrow('Bot installation');
 expect(await asActor(actor,()=>db.select().from(bots).where(eq(bots.id,botId)))).toHaveLength(0);
});
test('foreign global owner consents to installation without acquiring customer content access',async()=>{
 const request=await asActor(actor,()=>requestBotForWorkspace(wid,botId,actor));
 if(request.status!=='pending')throw new Error('Expected consent request');
 let delivered=0;
 await asActor(other,()=>withAuthorizedRealtimeEvent(other,{type:'bot_workspace_invite_received',invite:request.invite},()=>{delivered++;}));expect(delivered).toBe(1);
 expect((await asActor(other,()=>listOwnedPendingBotWorkspaceInvites(other))).map(i=>i.id)).toContain(request.invite.id);
 const result=await asActor(other,()=>acceptBotWorkspaceInvite(request.invite.id,other));expect(result.success).toBe(true);
 expect(await asActor(actor,()=>db.select().from(bots).where(eq(bots.id,botId)))).toHaveLength(0);
 expect(await asActor(other,()=>db.select().from(conversations).where(eq(conversations.id,channel)))).toHaveLength(0);
 expect(await asActor(other,()=>db.select().from(workspaceMembers).where(eq(workspaceMembers.workspaceId,wid)))).toHaveLength(0);
 const [grant]=await owner`select enabled from bot_workspace_installations where workspace_id=${wid} and bot_id=${botId}`;expect(grant!.enabled).toBe(true);
});
test('SQL content reads intersect bot installation enablement and selected channel scope',async()=>{
 const [message]=await owner`insert into messages(conversation_id,sender_id,content) values (${channel},${actor},'scoped bot content') returning id`;
 expect(await asActor(botUser,()=>db.execute(sql`select id from messages where id=${message!.id}::uuid`))).toHaveLength(1);
 await owner`update bot_workspace_installations set channel_scope='selected' where workspace_id=${wid} and bot_id=${botId}`;
 expect(await asActor(botUser,()=>db.execute(sql`select id from messages where id=${message!.id}::uuid`))).toHaveLength(0);
 expect(await asActor(actor,()=>db.execute(sql`select id from messages where id=${message!.id}::uuid`))).toHaveLength(1);
 await owner`update bot_workspace_installations set channel_scope='all',enabled=false where workspace_id=${wid} and bot_id=${botId}`;
 expect(await asActor(botUser,()=>db.select().from(conversations).where(eq(conversations.id,channel)))).toHaveLength(0);
 expect(await asActor(botUser,()=>db.select().from(workspaces).where(eq(workspaces.id,wid)))).toHaveLength(0);
 await expect(asActor(botUser,()=>requireBotInstallationAccess(db,channel,botUser))).rejects.toMatchObject({status:403});
});
test('maintenance can lock endpoints through the narrow RPC but cannot mutate global connector columns',async()=>{
 const [privileges]=await withWorkerDatabaseContext(()=>db.execute<{canUpdate:boolean;canUpdateEndpoint:boolean;canUpdateCommands:boolean}>(sql`select has_column_privilege(current_user,'bots','endpoint_revision','UPDATE') as "canUpdate",has_function_privilege(current_user,'public.thechat_update_own_bot_endpoint(uuid,text)','EXECUTE') as "canUpdateEndpoint",has_function_privilege(current_user,'public.thechat_update_own_bot_commands(uuid,jsonb)','EXECUTE') as "canUpdateCommands"`));
 expect(privileges!).toEqual({canUpdate:false,canUpdateEndpoint:false,canUpdateCommands:false});
});
test('foreign workspace lifecycle reads and writes fail closed; cleanup is worker-only',async()=>{
 await owner`insert into workspace_resource_limits values (${foreign},1000,2,2,1,1)`;
 await owner`insert into workspace_work(workspace_id,kind,idempotency_key) values (${foreign},'bot','foreign')`;
 await owner`insert into workspace_attachment_charges(attachment_id,workspace_id,bytes,capability_until) values (${crypto.randomUUID()},${foreign},20,now())`;
 for(const table of [workspaceResourceLimits,workspaceWork,workspaceAttachmentCharges])expect(await asActor(actor,()=>db.select().from(table))).toHaveLength(0);
 await expect(asActor(actor,()=>db.insert(workspaceWork).values({workspaceId:foreign,kind:'bot',idempotencyKey:'attack'}))).rejects.toThrow();
 await expect(asActor(actor,()=>db.select().from(attachmentObjectCleanup))).rejects.toThrow();
 const [r]=await withWorkerDatabaseContext(()=>db.execute(sql`select current_user, (select rolsuper from pg_roles where rolname=current_user) as superuser`));expect(r!.superuser).toBe(false);
});
test('foreign global owner withdraws its bot without customer content or roster authority and drains durable work',async()=>{
 await owner`update bots set kind='hermes' where id=${botId}`;
 await owner`update bot_workspace_installations set enabled=true where workspace_id=${wid} and bot_id=${botId}`;
 await owner`insert into conversation_participants(conversation_id,user_id) values (${channel},${actor}) on conflict do nothing`;
 const message=await asActor(actor,()=>sendMessage(channel,actor,'A','@foreign bot test removal'));
 const [outbox]=await owner`select id,event from event_outbox where event_type='chat.message.sent' and event->'payload'->>'messageId'=${message.id}`;
 expect(outbox!.event.payload.targetBotIds).toEqual([botId]);
 await withWorkerDatabaseContext(()=>createChatMessageSentHandler().handle(outbox!.event));
 const [claimed]=await asActor(botUser,()=>claimHermesPlatformEvents(botId,10));expect(claimed!.workToken).toBeString();
 const result=await asActor(other,()=>removeBotFromWorkspace(botId,wid,other));expect(result.removed).toBe(true);expect(result.recipientIds).toEqual([]);
 expect(await asActor(other,()=>db.select().from(conversations).where(eq(conversations.id,channel)))).toHaveLength(0);
 expect(await asActor(other,()=>db.select().from(workspaceMembers).where(eq(workspaceMembers.workspaceId,wid)))).toHaveLength(0);
 const [invocation]=await owner`select status from bot_invocations where id=${claimed!.id}`;expect(invocation!.status).toBe('cancelled');
 const [work]=await owner`select state from workspace_work where workspace_id=${wid} and idempotency_key=${claimed!.id}`;expect(work!.state).toBe('cancelled');
 const [pending]=await owner`select dead_at,event from event_outbox where id=${outbox!.id}`;expect(pending!.dead_at).not.toBeNull();expect(pending!.event.payload.targetBotIds).toEqual([]);
 expect(await owner`select 1 from bot_workspace_installations where workspace_id=${wid} and bot_id=${botId}`).toHaveLength(0);
 expect(await owner`select 1 from workspace_members where workspace_id=${wid} and user_id=${botUser}`).toHaveLength(0);
 expect(await owner`select 1 from messages where id=${message.id}`).toHaveLength(1);
 const [notice]=await owner`select event from event_outbox where event->'payload'->'event'->>'type'='member_removed' and event->'tenant'->>'workspaceId'=${wid}`;
 expect(notice!.event.payload.targetUserIds).toContain(actor);
 await expect(asActor(botUser,()=>completeHermesPlatformInvocationSilently({authenticatedBotId:botId,invocationId:claimed!.id,workToken:claimed!.workToken}))).rejects.toMatchObject({status:404});
 expect((await asActor(other,()=>removeBotFromWorkspace(botId,wid,other))).removed).toBe(false);
 expect((await asActor(other,()=>removeBotFromWorkspace(botId,'unknown-workspace',other))).removed).toBe(false);
});
