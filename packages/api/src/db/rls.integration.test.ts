import { afterAll, expect, test } from "bun:test";
import postgres from "postgres";
// postgres@3.4.8 TransactionSql's Omit loses its real callable signature.
const tag = (tx: postgres.TransactionSql) => tx as unknown as postgres.Sql;
import crypto from "node:crypto";
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql as querySql } from 'drizzle-orm';
import { collaborationPolicyDefinitions } from "./policies";
const runtimeRole=new URL(process.env.DATABASE_URL!).username;
import { verifyRuntimeDatabase } from './role';

test('startup refuses a same-name permissive policy that weakens the canonical tenant guard', async()=> {
  const marker=new Error('rollback unsafe policy');
  try {await drizzle(owner).transaction(async tx=> {
    await tx.execute(querySql`alter policy tenant_access on messages using (thechat_can_conversation(conversation_id) OR true)`);
    await tx.execute(querySql`set local role ${querySql.identifier(runtimeRole)}`);
    await expect(verifyRuntimeDatabase(tx)).rejects.toThrow('Unsafe collaboration RLS policy');
    throw marker;
  });} catch(error) {if(error!==marker) throw error;}
});

const owner = postgres(process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL!, { max: 2 });
afterAll(() => owner.end());
const rollbackMarker = new Error('rollback RLS fixture');

test('RLS cannot be laundered by detaching workspace ownership or retargeting an invitation', async () => {
  const marker = new Error('rollback immutable scope');
  try { await owner.begin(async tx=> {
    const [actor,other]=await tag(tx)`insert into users(name) values ('immutable actor'),('other tenant owner') returning id`;
    const a=`immutable-a-${crypto.randomUUID()}`,b=`immutable-b-${crypto.randomUUID()}`;
    await tag(tx)`insert into workspaces(id,name,created_by_id) values (${a},'A',${actor!.id}),(${b},'B',${other!.id})`;
    await tag(tx)`insert into workspace_members(workspace_id,user_id,role) values (${a},${actor!.id},'owner'),(${b},${other!.id},'owner')`;
    const [conversation]=await tag(tx)`insert into conversations(type,workspace_id) values ('direct',${a}) returning id`;
    await tag(tx)`insert into conversation_participants(conversation_id,user_id) values (${conversation!.id},${actor!.id})`;
    const [invite]=await tag(tx)`insert into workspace_invites(workspace_id,inviter_id,invitee_id) values (${a},${actor!.id},${actor!.id}) returning id`;
    await tag(tx)`set local role ${tag(tx)(runtimeRole)}`;
    await tag(tx)`select set_config('thechat.actor_id',${actor!.id},true),set_config('thechat.scope','actor',true)`;
    for (const mutation of [
      (sp: postgres.TransactionSql)=>tag(sp)`update conversations set workspace_id=NULL where id=${conversation!.id}`,
      (sp: postgres.TransactionSql)=>tag(sp)`update workspace_invites set workspace_id=${b},inviter_id=${other!.id} where id=${invite!.id}`,
    ]) {
      let error: any;
      try { await tx.savepoint(mutation); } catch(caught) {error=caught;}
      expect(error?.code).toBe('42501');
    }
    throw marker;
  }); } catch(error) {if(error!==marker) throw error;}
});

test('legacy unscoped groups do not become public through workspace-wide channel policy', async()=> {
  const marker=new Error('rollback legacy group');
  try {await owner.begin(async tx=> {
    const [actor,other]=await tag(tx)`insert into users(name) values ('legacy outsider'),('legacy sender') returning id`;
    const [conversation]=await tag(tx)`insert into conversations(type) values ('group') returning id`;
    const [message]=await tag(tx)`insert into messages(conversation_id,sender_id,content) values (${conversation!.id},${other!.id},'unscoped legacy group secret') returning id`;
    await tag(tx)`set local role ${tag(tx)(runtimeRole)}`;
    await tag(tx)`select set_config('thechat.actor_id',${actor!.id},true),set_config('thechat.scope','actor',true)`;
    expect(await tag(tx)`select id from messages where id=${message!.id}`).toHaveLength(0);
    throw marker;
  });} catch(error) {if(error!==marker) throw error;}
});

test('startup refuses an unregistered tenant table even when its permissive policy mentions a scope helper', async()=> {
  const marker=new Error('rollback extension policy probe');
  try {await drizzle(owner).transaction(async tx=> {
    await tx.execute(querySql`create table public.rls_extension_probe(id uuid primary key,workspace_id text not null)`);
    await tx.execute(querySql`alter table public.rls_extension_probe enable row level security`);
    await tx.execute(querySql`create policy tenant_access on public.rls_extension_probe using (thechat_can_workspace(workspace_id) OR true) with check (thechat_can_workspace(workspace_id) OR true)`);
    await tx.execute(querySql`grant select,insert,update,delete on public.rls_extension_probe to ${querySql.identifier(runtimeRole)}`);
    await tx.execute(querySql`set local role ${querySql.identifier(runtimeRole)}`);
    await expect(verifyRuntimeDatabase(tx)).rejects.toThrow('Unregistered protected database table: rls_extension_probe');
    throw marker;
  });} catch(error) {if(error!==marker) throw error;}
});

const protectedTables = Object.keys(collaborationPolicyDefinitions).filter(name=>name!=="attachment_object_cleanup" && name!=="apikey");

test('every protected collaboration table has an enabled fail-closed policy', async () => {
  try { await owner.begin(async tx => {
    const rows = await tag(tx)`select c.relname,c.relrowsecurity,(select count(*) from pg_policy p where p.polrelid=c.oid)::int as policies from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname=any(${protectedTables})`;
    expect(rows).toHaveLength(protectedTables.length);
    for (const row of rows) {
      expect({ table: row.relname, enabled: row.relrowsecurity, policies: row.policies>0 }).toEqual({ table: row.relname, enabled: true, policies: true });
    }
    await tag(tx)`set local role ${tag(tx)(runtimeRole)}`;
    for (const table of protectedTables) expect(await tx.unsafe(`select * from ${table}`)).toHaveLength(0);
    throw rollbackMarker;
  }); } catch (error) { if (error !== rollbackMarker) throw error; }
});

test('RLS hides and rejects cross-workspace collaboration tuples for actor A', async () => {
  try { await owner.begin(async tx => {
    const [a, b] = await tag(tx)`insert into users(name) values ('RLS actor A'),('RLS actor B') returning id`;
    const wa = `rls-a-${crypto.randomUUID()}`, wb = `rls-b-${crypto.randomUUID()}`;
    await tag(tx)`insert into workspaces(id,name,created_by_id) values (${wa},'A',${a!.id}),(${wb},'B',${b!.id})`;
    await tag(tx)`insert into workspace_members(workspace_id,user_id) values (${wa},${a!.id}),(${wb},${b!.id})`;
    const [ca, cb] = await tag(tx)`insert into conversations(type,workspace_id) values ('direct',${wa}),('direct',${wb}) returning id`;
    // Deliberately stale participation: B-workspace membership is absent for A.
    await tag(tx)`insert into conversation_participants(conversation_id,user_id) values (${ca!.id},${a!.id}),(${cb!.id},${b!.id}),(${cb!.id},${a!.id})`;
    const [ma, mb] = await tag(tx)`insert into messages(conversation_id,sender_id,content) values (${ca!.id},${a!.id},'A secret'),(${cb!.id},${b!.id},'B secret') returning id`;
    await tag(tx)`set local role ${tag(tx)(runtimeRole)}`;
    await tag(tx)`select set_config('thechat.actor_id',${a!.id},true),set_config('thechat.scope','actor',true)`;
    expect((await tag(tx)`select id from messages where id in (${ma!.id},${mb!.id})`).map(row => row.id)).toEqual([ma!.id]);
    expect(await tag(tx)`update messages set content='stolen' where id=${mb!.id} returning id`).toHaveLength(0);
    expect(await tag(tx)`delete from messages where id=${mb!.id} returning id`).toHaveLength(0);
    let denied: any;
    try { await tx.savepoint(sp => tag(sp)`insert into messages(conversation_id,sender_id,content) values (${cb!.id},${a!.id},'denied')`); }
    catch (error) { denied = error; }
    expect(denied?.code).toBe('42501');
    expect(await tag(tx)`update messages set content='allowed' where id=${ma!.id} returning id`).toHaveLength(1);
    await tag(tx)`select set_config('thechat.scope',${'workspace:'+wb},true)`;
    expect(await tag(tx)`select id from messages where id=${ma!.id}`).toHaveLength(0);
    throw rollbackMarker;
  }); } catch (error) { if (error !== rollbackMarker) throw error; }
});

test('restricted non-owner role without actor and scope cannot read collaboration rows', async () => {
  try { await owner.begin(async tx => {
    const [user] = await tag(tx)`insert into users(name) values ('RLS missing context') returning id`;
    const workspace = `rls-${crypto.randomUUID()}`;
    await tag(tx)`insert into workspaces(id,name,created_by_id) values (${workspace},'RLS sentinel',${user!.id})`;
    await tag(tx)`insert into workspace_members(workspace_id,user_id) values (${workspace},${user!.id})`;
    await tag(tx)`set local role ${tag(tx)(runtimeRole)}`;
    const [role] = await tag(tx)`select current_user as name,rolsuper,rolbypassrls from pg_roles where rolname=current_user`;
    expect(role!.rolsuper).toBe(false);
    expect(role!.rolbypassrls).toBe(false);
    expect(await tag(tx)`select id from workspaces where id=${workspace}`).toHaveLength(0);
    throw rollbackMarker;
  }); } catch (error) { if (error !== rollbackMarker) throw error; }
});
