import { beforeAll, afterAll, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';

// Dedicated upgrade DB only: never reset/drop a database and never point this
// gate at the ordinary service database. It is an explicit opt-in release gate.
const upgradeUrl=process.env.THECHAT_TENANCY_UPGRADE_TEST_URL;
const migrationTest=upgradeUrl ? test : test.skip;
const migrationsFolder=fileURLToPath(new URL('../../drizzle/',import.meta.url));
let owner: ReturnType<typeof postgres>, malformedMessageId: string, expectedBaseCount: number;
beforeAll(async()=> {
  if(!upgradeUrl) return;
  const parsed=new URL(upgradeUrl);
  if(!['127.0.0.1','localhost','::1'].includes(parsed.hostname) || !parsed.pathname.endsWith('_e2e') || upgradeUrl===process.env.DATABASE_URL || upgradeUrl===process.env.DATABASE_MIGRATION_URL) throw new Error('Upgrade gate requires a separate loopback disposable *_e2e database');
  if(!process.env.TMPDIR) throw new Error('Explicit test TMPDIR is required');
  owner=postgres(upgradeUrl,{max:1});
  const existing=await owner`select count(*)::int as count from pg_tables where schemaname='public'`;
  expect(existing[0]!.count).toBe(0);
  const stage=await mkdtemp(join(process.env.TMPDIR,'tenant-db-base-'));
  await mkdir(join(stage,'meta'));
  const journal=JSON.parse(await readFile(join(migrationsFolder,'meta/_journal.json'),'utf8'));
  journal.entries=journal.entries.filter((entry: {idx: number})=>entry.idx<=16);
  expectedBaseCount=journal.entries.length;
  await writeFile(join(stage,'meta/_journal.json'),JSON.stringify(journal));
  for(const entry of journal.entries) await copyFile(join(migrationsFolder,`${entry.tag}.sql`),join(stage,`${entry.tag}.sql`));
  await migrate(drizzle(owner),{migrationsFolder:stage});
  const [user]=await owner`insert into users(name) values ('legacy upgrade attribution') returning id`;
  const [botUser]=await owner`insert into users(name,type) values ('legacy bot','bot') returning id`;
  const [bot]=await owner`insert into bots(user_id,owner_id,webhook_secret) values (${botUser!.id},${user!.id},'synthetic-upgrade') returning id`;
  const workspace=`legacy-${crypto.randomUUID()}`;
  await owner`insert into workspaces(id,name,created_by_id) values (${workspace},'legacy',${user!.id})`;
  const [a,b]=await owner`insert into conversations(type,workspace_id) values ('group',${workspace}),('group',${workspace}) returning id`;
  const [thread]=await owner`insert into conversation_threads(conversation_id,bot_id,title,created_by_id) values (${b!.id},${bot!.id},'legacy thread',${user!.id}) returning id`;
  const [message]=await owner`insert into messages(conversation_id,thread_id,sender_id,content) values (${a!.id},${thread!.id},${user!.id},'preserve malformed legacy payload') returning id`;
  malformedMessageId=message!.id;
});
afterAll(async()=> {if(owner) await owner.end();});

migrationTest('0017 preflight fails closed without dropping legacy rows or advancing migration history', async()=> {
  let failure: any;
  try {await migrate(drizzle(owner),{migrationsFolder});} catch(error) {failure=error;}
  const cause=failure?.cause??failure;
  expect(cause?.code).toBe('P0001');
  expect(cause?.message).toContain('tenant preflight: messages/thread mismatch');
  expect((await owner`select content from messages where id=${malformedMessageId}`)[0]!.content).toBe('preserve malformed legacy payload');
  expect((await owner`select count(*)::int as count from drizzle.__drizzle_migrations`)[0]!.count).toBe(expectedBaseCount);
  expect((await owner`select count(*)::int as count from information_schema.columns where table_name='message_attachments' and column_name='conversation_id'`)[0]!.count).toBe(0);
});

migrationTest('reviewed explicit legacy repair permits an upgrade with validated constraints and policies', async()=> {
  // Preserve the payload and its conversation. Repair the mismatched optional
  // thread attribution explicitly; never let the migration choose a repair.
  await owner`update messages set thread_id=NULL where id=${malformedMessageId}`;
  await migrate(drizzle(owner),{migrationsFolder});
  expect((await owner`select content from messages where id=${malformedMessageId}`)[0]!.content).toBe('preserve malformed legacy payload');
  expect((await owner`select count(*)::int as count from drizzle.__drizzle_migrations`)[0]!.count).toBe(expectedBaseCount+1);
  expect((await owner`select count(*)::int as count from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and c.relrowsecurity`)[0]!.count).toBe(19);
  expect((await owner`select count(*)::int as count from pg_constraint where conname='messages_thread_conversation_fk' and convalidated`)[0]!.count).toBe(1);
});
