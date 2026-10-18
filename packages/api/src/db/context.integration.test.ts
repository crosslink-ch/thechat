import { afterAll, beforeAll, expect, test } from "bun:test";
import * as database from './index';
import { eq, inArray, sql } from "drizzle-orm";
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import crypto from 'node:crypto';
import { botIdentities, bots as schemaBots, messages, workspaces, users as schemaUsers } from "./schema";
import { verifyRuntimeDatabase } from './role';
import { withWorkerDatabaseContext } from './context';

const owner = postgres(process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL!, {max: 2});
const actors: string[] = [], workspacesIds: string[] = [], conversations: string[] = [], messageIds: string[] = [];
let foreignBotId: string, foreignBotUserId: string;
beforeAll(async () => {
  for (const name of ['A','B']) {
    const [user]=await owner`insert into users(name) values (${`pooled actor ${name}`}) returning id`;
    const actor=user!.id, workspace=`pool-${crypto.randomUUID()}`;
    actors.push(actor); workspacesIds.push(workspace);
    await owner`insert into workspaces(id,name,created_by_id) values (${workspace},${name},${actor})`;
    await owner`insert into workspace_members(workspace_id,user_id) values (${workspace},${actor})`;
    const [conversation]=await owner`insert into conversations(type,workspace_id) values ('group',${workspace}) returning id`;
    conversations.push(conversation!.id);
    const [message]=await owner`insert into messages(conversation_id,sender_id,content) values (${conversation!.id},${actor},${name}) returning id`;
    messageIds.push(message!.id);
  }
  const [botUser]=await owner`insert into users(name,type) values ('foreign private connector','bot') returning id`;
  foreignBotUserId=botUser!.id;
  const [bot]=await owner`insert into bots(user_id,owner_id,webhook_secret) values (${foreignBotUserId},${actors[1]!},'must-not-cross-tenant') returning id`;
  foreignBotId=bot!.id;
});
afterAll(async () => {
  for(const workspace of workspacesIds) await owner`delete from workspaces where id=${workspace}`;
  for(const actor of actors) await owner`delete from users where id=${actor}`;
  if(foreignBotUserId) await owner`delete from users where id=${foreignBotUserId}`;
  await owner.end(); await database.closeDatabaseConnections();
});

test('startup rejects an owner credential configured as the global authentication authority', async () => {
  const original=process.env.DATABASE_AUTH_URL;
  await database.closeDatabaseConnections();
  process.env.DATABASE_AUTH_URL=process.env.DATABASE_MIGRATION_URL;
  try { await expect(database.assertDatabaseSafety()).rejects.toThrow('Unsafe authentication database role'); }
  finally { process.env.DATABASE_AUTH_URL=original; await database.closeDatabaseConnections(); }
});

test('worker context refuses a runtime URL instead of silently using broad default authority', async () => {
  const original=process.env.DATABASE_WORKER_URL;
  await database.closeDatabaseConnections();
  process.env.DATABASE_WORKER_URL=process.env.DATABASE_URL;
  try { await expect(withWorkerDatabaseContext(async()=>await database.db.select().from(workspaces))).rejects.toThrow('Unsafe worker database role'); }
  finally {process.env.DATABASE_WORKER_URL=original;await database.closeDatabaseConnections();}
});

test('explicit worker context uses a separate non-owner maintenance role', async()=> {
  await withWorkerDatabaseContext(async()=> {
    const [role]=await database.db.execute<{name: string; bypass: boolean; superuser: boolean}>(sql`select current_user as name,rolbypassrls as bypass,rolsuper as superuser from pg_roles where rolname=current_user`);
    expect(role).toEqual({name:new URL(process.env.DATABASE_WORKER_URL!).username,bypass:true,superuser:false});
    expect((await database.db.select({id:messages.id}).from(messages).where(inArray(messages.id,messageIds))).map(row=>row.id).sort()).toEqual([...messageIds].sort());
  });
});

test('actor A cannot delete another global identity to cascade around tenant RLS', async()=> {
  const rollback=new Error('rollback global identity probe');
  try {await database.withDatabaseContext({actorId:actors[0]!,scope:'actor'},()=>database.db.transaction(async tx=> {
    const rows=await tx.delete(schemaUsers).where(eq(schemaUsers.id,actors[1]!)).returning({id:schemaUsers.id});
    expect(rows).toHaveLength(0);
    throw rollback;
  }));} catch(error) {if(error!==rollback) throw error;}
});

test('global identity discovery cannot expose an unrelated tenant connector secret', async()=> {
  await database.withDatabaseContext({actorId:actors[0]!,scope:'actor'},async()=> {
    expect(await database.db.select().from(schemaBots).where(eq(schemaBots.id,foreignBotId))).toHaveLength(0);
    const [identity]=await database.db.select().from(botIdentities).where(eq(botIdentities.id,foreignBotId));
    expect(identity?.id).toBe(foreignBotId);
    expect(identity).not.toHaveProperty('webhookSecret');
    expect(identity).not.toHaveProperty('webhookUrl');
  });
});

test('explicit transaction isolation is preserved by the contextual facade', async()=> {
  await database.withDatabaseContext({actorId:actors[0]!,scope:'actor'},()=>database.db.transaction(async tx=> {
    const [settings]=await tx.execute<{isolation: string}>(sql`select current_setting('transaction_isolation') as isolation`);
    expect(settings?.isolation).toBe('serializable');
  },{isolationLevel:'serializable'}));
});

test('unsafe owner application URL is rejected before serving actor queries', async () => {
  await expect(verifyRuntimeDatabase(drizzle(owner))).rejects.toThrow('Unsafe application database role');
});

test('application database facade rejects queries without explicit authority', async () => {
  await expect((async()=>await database.db.select().from(workspaces))()).rejects.toThrow('Database actor/scope context is required');
});

test('parallel and reused pooled transactions keep authenticated actor and scope isolated', async () => {
  const results=await Promise.all(Array.from({length:24},(_,i)=> {
    const actorIndex=i%2;
    return database.withDatabaseContext({actorId:actors[actorIndex]!,scope:'actor'},()=>database.db.transaction(async tx=> {
      await tx.execute(sql`select pg_sleep(0.005)`);
      const [settings]=await tx.execute<{actor: string; scope: string; role: string}>(sql`select current_setting('thechat.actor_id',true) as actor,current_setting('thechat.scope',true) as scope,current_user as role`);
      const rows=await database.db.select({id:messages.id}).from(messages);
      return {actorIndex,settings,ids:rows.map(row=>row.id)};
    }));
  }));
  for(const result of results) {
    expect(result.settings).toEqual({actor:actors[result.actorIndex],scope:'actor',role:new URL(process.env.DATABASE_URL!).username});
    expect(result.ids).toEqual([messageIds[result.actorIndex]]);
  }
  // Same application pool, outside any actor transaction. Health may inspect
  // only role/connectivity/GUC metadata; it must never inherit a tenant context.
  for(let i=0;i<8;i++) expect(await database.checkDatabaseHealth()).toBe(true);
});

test('authenticated scope cannot elevate to worker authority or replace actor identity', async () => {
  await database.withDatabaseContext({actorId:actors[0]!,scope:'actor'},async()=> {
    await expect(withWorkerDatabaseContext(async()=>true)).rejects.toThrow('cannot elevate');
    await expect(database.withDatabaseContext({actorId:actors[1]!,scope:'actor'},async()=>true)).rejects.toThrow('Cannot replace');
  });
});
