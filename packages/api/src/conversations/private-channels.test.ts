import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { Elysia } from "elysia";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { activityRoutes } from "../activity";
import { authRoutes } from "../auth";
import { botRequestRoutes } from "../bot-requests";
import { botRoutes } from "../bots";
import { db } from "../db";
import { users, workspaces } from "../db/schema";
import { inviteRoutes } from "../invites";
import { mcpRoutes } from "../mcp";
import { messageRoutes } from "../messages";
import { searchRoutes } from "../search";
import { workspaceRoutes } from "../workspaces";
import { wsRoutes } from "../ws";
import { conversationRoutes } from ".";

/**
 * Features added while every channel was public (search, the MCP tools,
 * Activity, realtime) must treat a private channel as invisible to workspace
 * members who were not picked. One real server, real sockets, real MCP client.
 */
const app = new Elysia()
  .use(authRoutes)
  .use(workspaceRoutes)
  .use(inviteRoutes)
  .use(conversationRoutes)
  .use(messageRoutes)
  .use(searchRoutes)
  .use(activityRoutes)
  .use(botRoutes)
  .use(botRequestRoutes)
  .use(mcpRoutes)
  .use(wsRoutes)
  .listen(0);
const baseUrl = `http://127.0.0.1:${app.server!.port}`;
const run = crypto.randomUUID().slice(0, 8);
const createdEmails: string[] = [];
const createdBotUserIds: string[] = [];
const createdWorkspaceIds: string[] = [];
const openSockets: WebSocket[] = [];

async function req(method: string, path: string, body?: unknown, token?: string) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: any = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* plain text */
  }
  return { status: response.status, body: parsed };
}

async function ok(method: string, path: string, body?: unknown, token?: string) {
  const response = await req(method, path, body, token);
  expect(response.status, `${method} ${path}: ${JSON.stringify(response.body)}`).toBe(200);
  return response.body;
}

async function register(name: string) {
  const email = `private-${crypto.randomUUID()}@example.invalid`;
  createdEmails.push(email);
  const body = await ok("POST", "/auth/register", { name, email, password: "password123" });
  return { token: body.accessToken as string, id: body.user.id as string, name, email };
}

type Person = Awaited<ReturnType<typeof register>>;

/** Collects every event a signed-in socket receives, in order. */
async function connect(token: string) {
  const socket = new WebSocket(`${baseUrl.replace("http://", "ws://")}/ws`);
  openSockets.push(socket);
  const events: any[] = [];
  socket.addEventListener("message", (message) => events.push(JSON.parse(String(message.data))));
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("websocket open failed")), { once: true });
  });
  socket.send(JSON.stringify({ type: "auth", token }));
  await until(() => events.some((event) => event.type === "auth_ok"), "websocket auth");
  return { socket, events };
}

async function until(condition: () => boolean, what: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function mcp(token: string) {
  const client = new Client({ name: "private-channel-test", version: "1.0.0" }, { capabilities: {} });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = (await client.callTool({ name, arguments: args })) as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    const text = result.content[0]?.text ?? "";
    return { isError: result.isError === true, text, json: result.isError ? null : JSON.parse(text) };
  };
  return { call, close: () => client.close() };
}

let owner: Person;
let picked: Person;
let outsider: Person;
let bot: { id: string; userId: string; apiKey: string };
let workspaceId: string;
let generalId: string;
let secretId: string;
let secretMessageId: string;
const secretName = `board-${run}`;
const secretWord = `nightingale${run}`;

beforeAll(async () => {
  owner = await register(`Owner ${run}`);
  picked = await register(`Picked ${run}`);
  outsider = await register(`Outsider ${run}`);
  const workspace = await ok("POST", "/workspaces/create", { name: `Private ${run}` }, owner.token);
  workspaceId = workspace.id;
  createdWorkspaceIds.push(workspaceId);
  for (const member of [picked, outsider]) {
    const invite = await ok("POST", "/invites/create", { workspaceId, email: member.email }, owner.token);
    await ok("POST", "/invites/accept", { inviteId: invite.id }, member.token);
  }
  // An agent that is in the workspace, like everyone else, but was not picked.
  bot = await ok("POST", "/bots/create", { name: `Agent ${run}`, kind: "hermes", workspaceId }, owner.token);
  createdBotUserIds.push(bot.userId);
  generalId = (await ok("GET", `/workspaces/${workspaceId}`, undefined, owner.token)).channels[0].id;
});

afterAll(async () => {
  for (const socket of openSockets) socket.close();
  app.stop();
  if (createdWorkspaceIds.length) await db.delete(workspaces).where(inArray(workspaces.id, createdWorkspaceIds));
  if (createdBotUserIds.length) await db.delete(users).where(inArray(users.id, createdBotUserIds));
  for (const email of createdEmails) await db.delete(users).where(eq(users.email, email));
});

describe("private channels stay invisible to workspace members who were not picked", () => {
  test("realtime: creation, messages, typing and reactions reach only members", async () => {
    const ownerSocket = await connect(owner.token);
    const pickedSocket = await connect(picked.token);
    const outsiderSocket = await connect(outsider.token);

    // Created through the MCP tool: agents and people share one rule.
    const ownerMcp = await mcp(owner.token);
    try {
      const created = await ownerMcp.call("create_channel", {
        workspaceId,
        name: secretName,
        isPrivate: true,
        memberIds: [picked.id],
      });
      expect(created.isError, created.text).toBe(false);
      expect(created.json).toMatchObject({ name: secretName, isPrivate: true });
      secretId = created.json.id;
    } finally {
      await ownerMcp.close();
    }

    const secret = await ok(
      "POST",
      `/messages/${secretId}`,
      { content: `The ${secretWord} budget is approved, @Outsider ${run} must not know` },
      owner.token,
    );
    secretMessageId = secret.id;
    pickedSocket.socket.send(JSON.stringify({ type: "typing", conversationId: secretId }));
    await ok("POST", `/messages/${secretId}/${secretMessageId}/reactions`, { emoji: "👍", active: true }, picked.token);
    // A public message sent afterwards proves the outsider's socket was live
    // the whole time: everything before it would have arrived by now.
    const barrier = await ok("POST", `/messages/${generalId}`, { content: `public barrier ${run}` }, owner.token);

    await until(
      () => outsiderSocket.events.some((event) => event.type === "new_message" && event.message.id === barrier.id),
      "the public barrier message on the outsider's socket",
    );
    await until(
      () => pickedSocket.events.some((event) => event.type === "new_message" && event.message.id === barrier.id),
      "the public barrier message on the member's socket",
    );
    await until(
      () => ownerSocket.events.some((event) => event.type === "typing" && event.conversationId === secretId),
      "the member's typing event on the owner's socket",
    );

    const pickedTypes = pickedSocket.events.map((event) => event.type);
    expect(pickedTypes).toContain("channel_created");
    expect(pickedSocket.events).toContainEqual(
      expect.objectContaining({ type: "new_message", message: expect.objectContaining({ id: secretMessageId }) }),
    );
    expect(JSON.stringify(ownerSocket.events)).toContain(secretId);

    const leaked = outsiderSocket.events.filter((event) => {
      const text = JSON.stringify(event);
      return text.includes(secretId) || text.includes(secretWord) || text.includes(secretName);
    });
    expect(leaked).toEqual([]);

    // Writing over the socket is refused too.
    outsiderSocket.socket.send(
      JSON.stringify({ type: "send_message", conversationId: secretId, clientMessageId: `x-${run}`, content: "let me in" }),
    );
    outsiderSocket.socket.send(JSON.stringify({ type: "typing", conversationId: secretId }));
    await until(
      () =>
        outsiderSocket.events.some((event) => event.type === "message_error" && event.clientMessageId === `x-${run}`) &&
        outsiderSocket.events.some((event) => event.type === "error"),
      "the refusals on the outsider's socket",
    );
    expect(ownerSocket.events.some((event) => event.type === "typing" && event.userId === outsider.id)).toBe(false);
    const stored = await ok("GET", `/messages/${secretId}`, undefined, owner.token);
    expect(stored.map((message: any) => message.content)).not.toContain("let me in");
  });

  test("direct reads and writes by a non-member are 403", async () => {
    const refused = [
      await req("GET", `/conversations/detail/${secretId}`, undefined, outsider.token),
      await req("GET", `/messages/${secretId}`, undefined, outsider.token),
      await req("GET", `/messages/${secretId}/task-page?unthreaded=true`, undefined, outsider.token),
      await req("POST", `/messages/${secretId}`, { content: "let me in" }, outsider.token),
      await req("POST", `/messages/${secretId}/${secretMessageId}/reactions`, { emoji: "👀", active: true }, outsider.token),
      await req("GET", `/conversations/threads/${secretId}`, undefined, outsider.token),
      await req("POST", `/activity/conversations/${secretId}/read`, { all: true }, outsider.token),
      await req("PATCH", `/conversations/channel/${secretId}`, { name: "renamed" }, outsider.token),
      await req("DELETE", `/conversations/channel/${secretId}`, undefined, outsider.token),
      // The uninvited agent, with its own key.
      await req("GET", `/messages/${secretId}`, undefined, bot.apiKey),
      await req("POST", `/messages/${secretId}`, { content: "agent here" }, bot.apiKey),
    ];
    expect(refused.map((response) => response.status)).toEqual(refused.map(() => 403));
    expect(JSON.stringify(refused.map((response) => response.body))).not.toContain(secretWord);
    // Agent requests answer "not found" for any conversation you cannot see.
    expect((await req("GET", `/bot-requests/conversations/${secretId}`, undefined, outsider.token)).status).toBe(404);
    expect((await req("GET", `/bot-requests/conversations/${secretId}`, undefined, picked.token)).status).toBe(200);

    // The member can do all of it.
    expect((await ok("GET", `/conversations/detail/${secretId}`, undefined, picked.token)).isPrivate).toBe(true);
    expect((await ok("GET", `/messages/${secretId}`, undefined, picked.token)).map((message: any) => message.id)).toEqual([
      secretMessageId,
    ]);
  });

  test("workspace listing shows the channel, with its lock flag, to members only", async () => {
    const forPicked = await ok("GET", `/workspaces/${workspaceId}`, undefined, picked.token);
    expect(forPicked.channels.find((channel: any) => channel.id === secretId)).toMatchObject({ isPrivate: true });
    expect(forPicked.channels.find((channel: any) => channel.id === generalId)).toMatchObject({ isPrivate: false });
    const forOutsider = await ok("GET", `/workspaces/${workspaceId}`, undefined, outsider.token);
    expect(forOutsider.channels.map((channel: any) => channel.id)).toEqual([generalId]);
  });

  test("message search, the quick switcher and message context", async () => {
    const hits = await ok("GET", `/search/messages?q=${secretWord}`, undefined, picked.token);
    expect(hits.results.map((hit: any) => hit.id)).toEqual([secretMessageId]);
    expect(hits.results[0]).toMatchObject({ conversationId: secretId, conversationName: secretName });

    expect((await ok("GET", `/search/messages?q=${secretWord}`, undefined, outsider.token)).results).toEqual([]);
    expect(
      (await ok("GET", `/search/messages?q=${secretWord}&workspaceId=${workspaceId}`, undefined, outsider.token)).results,
    ).toEqual([]);
    // Naming a conversation or message you cannot read is "not found", as for
    // any other unreadable conversation: search never confirms it exists.
    expect((await req("GET", `/search/messages?q=${secretWord}&conversationId=${secretId}`, undefined, outsider.token)).status).toBe(404);
    expect((await req("GET", `/search/messages/${secretMessageId}/context`, undefined, outsider.token)).status).toBe(404);
    expect((await ok("GET", `/search/messages/${secretMessageId}/context`, undefined, picked.token)).targetMessageId).toBe(
      secretMessageId,
    );

    const directoryIds = async (token: string) =>
      (await ok("GET", "/search/directory", undefined, token)).destinations
        .filter((entry: any) => entry.kind === "channel")
        .map((entry: any) => entry.conversationId);
    expect(await directoryIds(picked.token)).toContain(secretId);
    expect(await directoryIds(outsider.token)).toEqual([generalId]);

    const find = (token: string) => ok("GET", `/search/destinations?q=${secretName}&kinds=channel`, undefined, token);
    expect((await find(picked.token)).destinations[0]).toMatchObject({ kind: "channel", conversationId: secretId });
    expect((await find(outsider.token)).destinations.map((entry: any) => entry.conversationId)).not.toContain(secretId);
  });

  test("MCP search, find and read tools for a non-member person and an uninvited agent", async () => {
    for (const token of [outsider.token, bot.apiKey]) {
      const client = await mcp(token);
      try {
        expect((await client.call("search_messages", { query: secretWord })).json.results).toEqual([]);
        expect((await client.call("search_messages", { query: secretWord, conversationId: secretId })).isError).toBe(true);
        expect((await client.call("get_message_context", { messageId: secretMessageId })).isError).toBe(true);
        expect((await client.call("get_messages", { conversationId: secretId })).isError).toBe(true);
        expect((await client.call("send_message", { conversationId: secretId, content: "let me in" })).isError).toBe(true);
        const found = await client.call("find_conversations", { query: secretName, kinds: ["channel"] });
        expect(found.json.destinations.map((entry: any) => entry.conversationId)).not.toContain(secretId);
        const workspace = await client.call("get_workspace", { workspaceId });
        expect(workspace.json.channels.map((channel: any) => channel.id)).toEqual([generalId]);
        expect(workspace.text).not.toContain(secretName);
      } finally {
        await client.close();
      }
    }

    const member = await mcp(picked.token);
    try {
      expect((await member.call("search_messages", { query: secretWord })).json.results.map((hit: any) => hit.id)).toEqual([
        secretMessageId,
      ]);
      const found = await member.call("find_conversations", { query: secretName, kinds: ["channel"] });
      expect(found.json.destinations[0]).toMatchObject({ conversationId: secretId });
    } finally {
      await member.close();
    }
  });

  test("Activity and unread counts", async () => {
    const forPicked = await ok("GET", "/activity", undefined, picked.token);
    expect(forPicked.items).toContainEqual(
      expect.objectContaining({ conversationId: secretId, conversationName: secretName, unreadCount: 1 }),
    );
    // The outsider has the public barrier message unread, and nothing else.
    const forOutsider = await ok("GET", "/activity", undefined, outsider.token);
    expect(forOutsider.items.map((item: any) => item.conversationId)).toEqual([generalId]);
    expect(forOutsider.totalUnreadMessages).toBe(1);
    expect(JSON.stringify(forOutsider)).not.toContain(secretWord);
  });

  test("someone who joins the workspace later sees public channels only", async () => {
    const late = await register(`Late ${run}`);
    const invite = await ok("POST", "/invites/create", { workspaceId, email: late.email }, owner.token);
    await ok("POST", "/invites/accept", { inviteId: invite.id }, late.token);
    expect((await ok("GET", `/workspaces/${workspaceId}`, undefined, late.token)).channels.map((channel: any) => channel.id)).toEqual([
      generalId,
    ]);
    expect((await ok("GET", `/search/messages?q=${secretWord}`, undefined, late.token)).results).toEqual([]);
    expect((await req("GET", `/messages/${secretId}`, undefined, late.token)).status).toBe(403);
  });
});
