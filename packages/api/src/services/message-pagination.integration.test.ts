import { afterAll, beforeAll, expect, test } from 'bun:test';
import postgres from 'postgres';
import crypto from 'node:crypto';
import { withDatabaseContext } from '../db';
import { getMessages } from './messages';

const owner = postgres(process.env.DATABASE_MIGRATION_URL!, { max: 1 });
let actor: string, conversation: string, workspace: string;
let expectedIds: string[];
beforeAll(async () => {
  const [user] = await owner`insert into users(name) values ('cursor actor') returning id`;
  actor=user!.id; workspace=`cursor-${crypto.randomUUID()}`;
  await owner`insert into workspaces(id,name,created_by_id) values (${workspace},'cursor',${actor})`;
  await owner`insert into workspace_members(workspace_id,user_id) values (${workspace},${actor})`;
  const [row] = await owner`insert into conversations(type,workspace_id) values ('group',${workspace}) returning id`;
  conversation=row!.id;
  await owner`insert into conversation_participants(conversation_id,user_id) values (${conversation},${actor})`;
  for (let i=0;i<8;i++) {
    await owner`insert into messages(id,conversation_id,sender_id,content,created_at) values (${crypto.randomUUID()},${conversation},${actor},${`boundary-${i}`},${i<6 ? '2026-01-01T00:00:00.123456Z' : '2026-01-01T00:00:00.123457Z'})`;
  }
  expectedIds=(await owner`select id from messages where conversation_id=${conversation} order by created_at,id`).map(row => row.id);
});
afterAll(async () => {
  if(workspace) await owner`delete from workspaces where id=${workspace}`;
  if(actor) await owner`delete from users where id=${actor}`;
  await owner.end();
});

test('tuple cursor walks equal and sub-millisecond timestamps without dropping or repeating messages', async () => {
  const pages: string[][]=[];
  let before: string | undefined;
  for(let page=0;page<6;page++) {
    const rows=await withDatabaseContext({actorId:actor,scope:'actor'},()=>getMessages(conversation,actor,{limit:2,before}));
    if(rows.length===0) break;
    pages.unshift(rows.map(row=>row.id));
    before=(rows[0] as any).paginationCursor ?? rows[0]!.createdAt;
  }
  expect(pages.flat()).toEqual(expectedIds);
  expect(new Set(pages.flat()).size).toBe(expectedIds.length);
});
