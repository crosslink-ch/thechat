import { afterAll, expect, test } from "bun:test";
import crypto from "node:crypto";
import postgres from "postgres";
// postgres@3.4.8 TransactionSql's Omit loses its real callable signature.
const tag = (tx: postgres.TransactionSql) => tx as unknown as postgres.Sql;

const sql = postgres(process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL!, { max: 1 });
afterAll(() => sql.end());

async function fixture(tx: postgres.TransactionSql) {
  const [creator] = await tag(tx)`insert into users(name) values ('tenant constraint creator') returning id`;
  const [member] = await tag(tx)`insert into users(name) values ('tenant constraint member') returning id`;
  const [botUser] = await tag(tx)`insert into users(name,type) values ('tenant constraint bot','bot') returning id`;
  const [bot] = await tag(tx)`insert into bots(user_id,owner_id,webhook_secret) values (${botUser!.id},${member!.id},'synthetic') returning id`;
  const workspace = `invariant-${crypto.randomUUID()}`;
  await tag(tx)`insert into workspaces(id,name,created_by_id) values (${workspace},'constraint test',${creator!.id})`;
  await tag(tx)`insert into workspace_members(workspace_id,user_id) values (${workspace},${member!.id})`;
  const [a, b] = await tag(tx)`insert into conversations(type,workspace_id) values ('direct',${workspace}),('group',${workspace}) returning id`;
  await tag(tx)`insert into conversation_participants(conversation_id,user_id) values (${a!.id},${member!.id}),(${b!.id},${member!.id})`;
  const [thread] = await tag(tx)`insert into conversation_threads(conversation_id,bot_id,title,created_by_id) values (${b!.id},${bot!.id},'other conversation',${member!.id}) returning id`;
  return { creator: creator!.id, member: member!.id, bot: bot!.id, workspace, a: a!.id, b: b!.id, thread: thread!.id };
}

async function rollback(body: (tx: postgres.TransactionSql) => Promise<void>) {
  const marker = new Error('rollback fixture');
  try { await sql.begin(async tx => { await body(tx); throw marker; }); }
  catch (error) { if (error !== marker) throw error; }
}

test('thread creator attribution deletion preserves the collaboration thread', async () => {
  await rollback(async tx => {
    const f=await fixture(tx);
    await tag(tx)`update conversation_threads set created_by_id=${f.creator} where id=${f.thread}`;
    await tag(tx)`delete from users where id=${f.creator}`;
    const thread=await tag(tx)`select created_by_id,conversation_id from conversation_threads where id=${f.thread}`;
    expect(thread).toHaveLength(1);
    expect(thread[0]!.created_by_id).toBeNull();
    expect(thread[0]!.conversation_id).toBe(f.b);
  });
});

test('message history has tuple-order conversation and thread indexes', async () => {
  const indexes=await sql`select indexname,indexdef from pg_indexes where tablename='messages'`;
  expect(indexes.find(row=>row.indexname==='messages_conversation_order_idx')?.indexdef ?? '').toContain('(conversation_id, created_at, id)');
  expect(indexes.find(row=>row.indexname==='messages_conversation_thread_order_idx')?.indexdef ?? '').toContain('(conversation_id, thread_id, created_at, id)');
});

test('optional child deletion nulls only child keys and preserves non-null owners', async () => {
  await rollback(async tx=> {
    const f=await fixture(tx);
    const [trigger]=await tag(tx)`insert into messages(conversation_id,thread_id,sender_id,content) values (${f.b},${f.thread},${f.member},'trigger') returning id`;
    const [response]=await tag(tx)`insert into messages(conversation_id,thread_id,sender_id,content) values (${f.b},${f.thread},${f.member},'response') returning id`;
    const [invocation]=await tag(tx)`insert into bot_invocations(bot_id,conversation_id,thread_id,trigger_message_id,response_message_id,adapter_kind) values (${f.bot},${f.b},${f.thread},${trigger!.id},${response!.id},'webhook') returning id`;
    const [branch]=await tag(tx)`insert into conversation_threads(conversation_id,bot_id,branch_from_thread_id,title,created_by_id) values (${f.b},${f.bot},${f.thread},'branch',${f.member}) returning id`;
    await tag(tx)`set constraints all immediate`;
    await tag(tx)`delete from messages where id=${response!.id}`;
    const [afterResponse]=await tag(tx)`select response_message_id,conversation_id,bot_id from bot_invocations where id=${invocation!.id}`;
    expect(afterResponse!.response_message_id).toBeNull();
    expect(afterResponse!.conversation_id).toBe(f.b);
    expect(afterResponse!.bot_id).toBe(f.bot);
    await tag(tx)`set constraints all deferred`;
    await tag(tx)`delete from conversation_threads where id=${f.thread}`;
    await tag(tx)`set constraints all immediate`;
    const [afterThread]=await tag(tx)`select thread_id,conversation_id,bot_id from bot_invocations where id=${invocation!.id}`;
    const [afterMessage]=await tag(tx)`select thread_id,conversation_id from messages where id=${trigger!.id}`;
    const [afterBranch]=await tag(tx)`select branch_from_thread_id,conversation_id from conversation_threads where id=${branch!.id}`;
    expect(afterThread!.thread_id).toBeNull();
    expect(afterThread!.conversation_id).toBe(f.b);
    expect(afterThread!.bot_id).toBe(f.bot);
    expect(afterMessage!.thread_id).toBeNull();
    expect(afterMessage!.conversation_id).toBe(f.b);
    expect(afterBranch!.branch_from_thread_id).toBeNull();
    expect(afterBranch!.conversation_id).toBe(f.b);
  });
});

test('concurrent invocation insertion cannot race a trigger message into a different thread', async () => {
  const writer=postgres(process.env.DATABASE_MIGRATION_URL!,{max:1});
  const inserter=postgres(process.env.DATABASE_MIGRATION_URL!,{max:1});
  const f=await sql.begin(fixture);
  const [message]=await sql`insert into messages(conversation_id,sender_id,content) values (${f.b},${f.member},'concurrent scope') returning id`;
  let release!:()=>void, changed!:()=>void;
  const changeReady=new Promise<void>(resolve=>{changed=resolve;});
  const releaseChange=new Promise<void>(resolve=>{release=resolve;});
  const pending=writer.begin(async tx=> {
    await tag(tx)`update messages set thread_id=${f.thread} where id=${message!.id}`;
    await tag(tx)`set constraints all immediate`;
    changed(); await releaseChange;
  }).then(()=>null,error=>error);
  try {
    await changeReady;
    const [backend]=await inserter`select pg_backend_pid() as pid`;
    const inserted=inserter.begin(async tx=> {
      await tag(tx)`insert into bot_invocations(bot_id,conversation_id,trigger_message_id,adapter_kind) values (${f.bot},${f.b},${message!.id},'webhook')`;
      await tag(tx)`set constraints all immediate`;
    }).then(()=>null,error=>error);
    // Prove database lock admission, not timing-only overlap: tuple FKs wait
    // for the conflicting trigger scope update before validating their key.
    let blocked=false;
    const deadline=Date.now()+2000;
    while(Date.now()<deadline) {
      const [state]=await sql`select cardinality(pg_blocking_pids(${backend!.pid}::int))>0 as blocked`;
      if(state!.blocked) {blocked=true;break;}
      await Bun.sleep(10);
    }
    release();
    const results=await Promise.all([pending,inserted]);
    expect(blocked).toBe(true);
    expect(results.some(error=>error?.code==='23503')).toBe(true);
    expect(await sql`select i.id from bot_invocations i join messages m on m.id=i.trigger_message_id where i.conversation_id=${f.b} and i.thread_id is distinct from m.thread_id`).toHaveLength(0);
  } finally {
    release(); await pending; await writer.end(); await inserter.end();
    const [bot]=await sql`select user_id from bots where id=${f.bot}`;
    await sql`delete from workspaces where id=${f.workspace}`;
    await sql`delete from users where id in (${f.member},${f.creator},${bot!.user_id})`;
  }
});

export { fixture, rollback };

test('PostgreSQL invocation scope agrees with its trigger, response and thread', async () => {
  await rollback(async tx => {
    const f = await fixture(tx);
    const [aMessage] = await tag(tx)`insert into messages(conversation_id,sender_id,content) values (${f.a},${f.member},'trigger') returning id`;
    const [bMessage] = await tag(tx)`insert into messages(conversation_id,thread_id,sender_id,content) values (${f.b},${f.thread},${f.member},'response') returning id`;
    const invalid = [
      { conversation: f.b, thread: f.thread, trigger: aMessage!.id, response: null },
      { conversation: f.a, thread: null, trigger: aMessage!.id, response: bMessage!.id },
      { conversation: f.a, thread: f.thread, trigger: aMessage!.id, response: null },
      { conversation: f.b, thread: null, trigger: bMessage!.id, response: null },
    ];
    for (const row of invalid) {
      let error: any;
      try { await tx.savepoint(async sp => {
        await tag(sp)`insert into bot_invocations(bot_id,conversation_id,thread_id,trigger_message_id,response_message_id,adapter_kind) values (${f.bot},${row.conversation},${row.thread},${row.trigger},${row.response},'webhook')`;
        await tag(sp)`set constraints all immediate`;
      }); } catch (caught) { error = caught; }
      expect(error?.code).toBe('23503');
    }
  });
});

test('deleting creator attribution preserves workspace and other member records', async () => {
  await rollback(async tx => {
    const f = await fixture(tx);
    const [message] = await tag(tx)`insert into messages(conversation_id,sender_id,content) values (${f.a},${f.member},'survives creator') returning id`;
    await tag(tx)`delete from users where id=${f.creator}`;
    const workspace = await tag(tx)`select created_by_id from workspaces where id=${f.workspace}`;
    expect(workspace).toHaveLength(1);
    expect(workspace[0]!.created_by_id).toBeNull();
    expect(await tag(tx)`select id from messages where id=${message!.id}`).toHaveLength(1);
    expect(await tag(tx)`select user_id from workspace_members where workspace_id=${f.workspace}`).toHaveLength(1);
  });
});

test('PostgreSQL rejects an attachment/message pair in different conversations', async () => {
  await rollback(async tx => {
    const f = await fixture(tx);
    const [message] = await tag(tx)`insert into messages(conversation_id,sender_id,content) values (${f.a},${f.member},'attachment') returning id`;
    const [attachment] = await tag(tx)`insert into attachments(conversation_id,uploader_id,file_name,declared_media_type,declared_size_bytes,declared_checksum_sha256,quarantine_key,upload_expires_at,expires_at) values (${f.b},${f.member},'test.txt','text/plain',1,${'a'.repeat(64)},'synthetic',now()+interval '1 hour',now()+interval '1 hour') returning id`;
    let error: any;
    try { await tx.savepoint(sp => tag(sp)`insert into message_attachments(message_id,attachment_id,position) values (${message!.id},${attachment!.id},0)`); }
    catch (caught) { error = caught; }
    expect(error?.code).toBe('23503');
    expect(error?.constraint_name).toBe('message_attachments_attachment_conversation_fk');
  });
});

test('PostgreSQL rejects a message thread from another conversation', async () => {
  await rollback(async tx => {
    const f = await fixture(tx);
    let error: any;
    try {
      await tx.savepoint(async sp => {
        await tag(sp)`insert into messages(conversation_id,thread_id,sender_id,content) values (${f.a},${f.thread},${f.member},'cross scope')`;
      });
    } catch (caught) { error = caught; }
    expect(error?.code).toBe('23503');
    expect(error?.constraint_name).toBe('messages_thread_conversation_fk');
  });
});

test('PostgreSQL rejects an unread referencing a message in another conversation', async () => {
  await rollback(async tx => {
    const f = await fixture(tx);
    const [message] = await tag(tx)`insert into messages(conversation_id,sender_id,content) values (${f.a},${f.member},'unread') returning id`;
    let error: any;
    try { await tx.savepoint(sp => tag(sp)`insert into message_unreads(message_id,conversation_id,user_id) values (${message!.id},${f.b},${f.member})`); }
    catch (caught) { error = caught; }
    expect(error?.code).toBe('23503');
    expect(error?.constraint_name).toBe('message_unreads_message_conversation_fk');
  });
});
