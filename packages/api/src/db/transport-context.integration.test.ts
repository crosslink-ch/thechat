import { afterAll, beforeAll, expect, test } from "bun:test";
import { Elysia } from "elysia";
import crypto from "node:crypto";
import postgres from "postgres";
import { authRoutes } from "../auth";
import { messageRoutes } from "../messages";
import { mcpRoutes } from "../mcp";
import { conversationRoutes } from '../conversations';

import { closeRealtimeBusForTests } from '../realtime';

async function waitUntil(predicate: () => boolean, timeout = 3000) {
  const deadline = Date.now()+timeout;
  while (!predicate() && Date.now()<deadline) await Bun.sleep(10);
}

test('live authenticated WebSocket sends use restricted-role actor context and reject stale workspace DM access', async () => {
  const { wsRoutes } = await import('../ws');
  const server = new Elysia().use(wsRoutes).listen({ hostname: '127.0.0.1', port: 0 });
  const socket = new WebSocket(`ws://127.0.0.1:${server.server!.port}/ws`);
  const frames: any[] = [];
  socket.addEventListener('message',event => frames.push(JSON.parse(String(event.data))));
  try {
    await new Promise<void>((resolve,reject) => { socket.addEventListener('open',() => resolve(),{once:true}); socket.addEventListener('error',reject,{once:true}); });
    socket.send(JSON.stringify({ type: 'auth', token: tokenA }));
    await waitUntil(() => frames.some(frame => frame.type==='auth_ok'));
    expect(frames.some(frame => frame.type==='auth_ok')).toBe(true);
    socket.send(JSON.stringify({ type: 'send_message', conversationId: conversationA, clientMessageId: 'ws-authorized', content: 'authorized WS sentinel' }));
    await waitUntil(() => frames.some(frame => frame.type==='new_message' && frame.clientMessageId==='ws-authorized'));
    expect(frames.some(frame => frame.type==='new_message' && frame.message.content==='authorized WS sentinel')).toBe(true);
    const echoed=frames.find(frame => frame.type==='new_message' && frame.clientMessageId==='ws-authorized');
    expect(typeof echoed?.message.paginationCursor).toBe('string');
    expect(await owner`select id from messages where conversation_id=${conversationA} and client_message_id='ws-authorized'`).toHaveLength(1);
    socket.send(JSON.stringify({ type: 'send_message', conversationId: conversationB, clientMessageId: 'ws-denied', content: 'must not persist' }));
    await waitUntil(() => frames.some(frame => frame.type==='message_error' && frame.clientMessageId==='ws-denied'));
    expect(frames.find(frame => frame.type==='message_error' && frame.clientMessageId==='ws-denied')?.message).toMatch(/participant/);
    expect(await owner`select id from messages where client_message_id='ws-denied'`).toHaveLength(0);
  } finally {
    socket.close(); await Bun.sleep(30); await server.stop(); await closeRealtimeBusForTests();
  }
});

const mcpApp = new Elysia().use(mcpRoutes);
async function mcpCall(token: string, conversationId: string) {
  const response = await mcpApp.handle(new Request('http://localhost/mcp', {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_messages', arguments: { conversationId } } }),
  }));
  expect(response.status).toBe(200);
  return await response.json() as any;
}

test('standalone MCP transport binds its authenticated actor before invoking real services', async () => {
  const result = await mcpCall(tokenA,conversationA);
  expect(result.result.isError).not.toBe(true);
  expect(JSON.parse(result.result.content[0].text).map((message: any) => message.id)).toEqual((await owner`select id from messages where conversation_id=${conversationA} order by created_at,id`).map(row => row.id));
  const denied = await mcpCall(tokenA,conversationB);
  expect(denied.result.isError).toBe(true);
});

const owner = postgres(process.env.DATABASE_MIGRATION_URL!, { max: 2 });
const app = new Elysia().use(authRoutes).use(messageRoutes).use(conversationRoutes);
let tokenA: string, actorA: string, tokenB: string, actorB: string;
let workspaceA: string, workspaceB: string, conversationA: string, conversationB: string;
let messageA: string;

test('authorized member REST mutations can lock workspace rows without obtaining admin update permission', async () => {
  await owner`insert into workspace_members(workspace_id,user_id) values (${workspaceA},${actorB})`;
  await owner`insert into conversation_participants(conversation_id,user_id) values (${conversationA},${actorB})`;
  const response=await request('POST',`/messages/${conversationA}`,tokenB,{content:'authorized member sentinel'});
  expect(response.status).toBe(200);
  const result: any=await response.json();
  expect(result.content).toBe('authorized member sentinel');
});
async function request(method: string, path: string, token?: string, body?: unknown) {
  return app.handle(new Request(`http://localhost${path}`, {
    method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }));
}
beforeAll(async () => {
  for (const name of ['A','B']) {
    const response = await request('POST','/auth/register',undefined,{ name: `RLS transport ${name}`, email: `rls-${crypto.randomUUID()}@test.com`, password: 'synthetic-password-123' });
    expect(response.status).toBe(200);
    const result: any = await response.json();
    if (name === 'A') { tokenA=result.accessToken; actorA=result.user.id; }
    else { tokenB=result.accessToken; actorB=result.user.id; }
  }
  workspaceA=`transport-a-${crypto.randomUUID()}`; workspaceB=`transport-b-${crypto.randomUUID()}`;
  await owner`insert into workspaces(id,name,created_by_id) values (${workspaceA},'A',${actorA}),(${workspaceB},'B',${actorB})`;
  await owner`insert into workspace_members(workspace_id,user_id,role) values (${workspaceA},${actorA},'owner'),(${workspaceB},${actorB},'owner')`;
  const [a,b] = await owner`insert into conversations(type,workspace_id) values ('direct',${workspaceA}),('direct',${workspaceB}) returning id`;
  conversationA=a!.id; conversationB=b!.id;
  await owner`insert into conversation_participants(conversation_id,user_id) values (${conversationA},${actorA}),(${conversationB},${actorB}),(${conversationB},${actorA})`;
  const [message] = await owner`insert into messages(conversation_id,sender_id,content) values (${conversationA},${actorA},'authorized REST sentinel') returning id`;
  messageA=message!.id;
});
afterAll(async () => {
  if (workspaceA) await owner`delete from workspaces where id in (${workspaceA},${workspaceB})`;
  if (actorA) await owner`delete from users where id in (${actorA},${actorB})`;
  await owner.end();
});

test('REST DM creation commits conversation and participants in one actor transaction', async()=> {
  const [other]=await owner`insert into users(name) values ('new DM peer') returning id`;
  try {
    await owner`insert into workspace_members(workspace_id,user_id) values (${workspaceA},${other!.id})`;
    const created=await request('POST','/conversations/dm',tokenA,{workspaceId:workspaceA,otherUserId:other!.id});

    expect(created.status).toBe(200);
    const dm:any=await created.json();
    expect(await owner`select user_id from conversation_participants where conversation_id=${dm.id}`).toHaveLength(2);
    expect((await request('GET',`/messages/${dm.id}`,tokenA)).status).toBe(200);
  } finally {await owner`delete from users where id=${other!.id}`;}
});

test('authorized REST composes authenticated actor context with restricted-role message service', async () => {
  const response = await request('GET',`/messages/${conversationA}`,tokenA);
  expect(response.status).toBe(200);
  const messages: any = await response.json();
  expect(messages.map((message: any) => message.id)).toEqual((await owner`select id from messages where conversation_id=${conversationA} order by created_at,id`).map(row => row.id));
  const denied = await request('GET',`/messages/${conversationB}`,tokenA);
  expect(denied.status).toBe(403);
});
