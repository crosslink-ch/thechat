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
 * Managing a channel after it exists: members, admins, visibility, and what
 * happens when people leave. One real server, real sockets, real MCP client.
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
  const email = `manage-${crypto.randomUUID()}@example.invalid`;
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
  const client = new Client({ name: "channel-management-test", version: "1.0.0" }, { capabilities: {} });
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

let owner: Person; // workspace owner
let alice: Person; // regular workspace member
let bob: Person; // regular workspace member
let carol: Person; // regular workspace member
let workspaceId: string;
let generalId: string;
let n = 0;

async function join(person: Person) {
  const invite = await ok("POST", "/invites/create", { workspaceId, email: person.email }, owner.token);
  await ok("POST", "/invites/accept", { inviteId: invite.id }, person.token);
}

async function privateChannel(creator: Person, members: Person[]) {
  const name = `room-${run}-${++n}`;
  const channel = await ok(
    "POST",
    "/conversations/channel",
    { workspaceId, name, isPrivate: true, memberIds: members.map((member) => member.id) },
    creator.token,
  );
  return { id: channel.id as string, name, channel };
}

const members = (channel: any) =>
  Object.fromEntries((channel.members ?? []).map((member: any) => [member.userId, member.role]));

async function listed(person: Person, channelId: string) {
  const workspace = await ok("GET", `/workspaces/${workspaceId}`, undefined, person.token);
  return workspace.channels.find((channel: any) => channel.id === channelId) ?? null;
}

const path = (channelId: string, suffix = "") => `/conversations/channel/${channelId}${suffix}`;

beforeAll(async () => {
  owner = await register(`Owner ${run}`);
  alice = await register(`Alice ${run}`);
  bob = await register(`Bob ${run}`);
  carol = await register(`Carol ${run}`);
  const workspace = await ok("POST", "/workspaces/create", { name: `Manage ${run}` }, owner.token);
  workspaceId = workspace.id;
  createdWorkspaceIds.push(workspaceId);
  for (const person of [alice, bob, carol]) await join(person);
  generalId = (await ok("GET", `/workspaces/${workspaceId}`, undefined, owner.token)).channels[0].id;
});

afterAll(async () => {
  for (const socket of openSockets) socket.close();
  app.stop();
  if (createdWorkspaceIds.length) await db.delete(workspaces).where(inArray(workspaces.id, createdWorkspaceIds));
  if (createdBotUserIds.length) await db.delete(users).where(inArray(users.id, createdBotUserIds));
  for (const email of createdEmails) await db.delete(users).where(eq(users.email, email));
});

describe("a private channel is managed by its own members", () => {
  test("its creator is the channel admin, whatever their workspace role", async () => {
    const room = await privateChannel(alice, [bob]);
    expect(members(room.channel)).toEqual({ [alice.id]: "admin", [bob.id]: "member" });
    // Members see who is in it; everyone else sees no channel at all.
    expect(members(await listed(bob, room.id))).toEqual({ [alice.id]: "admin", [bob.id]: "member" });
    expect(await listed(owner, room.id)).toBeNull();
    expect((await listed(owner, generalId)).members).toBeUndefined();

    const renamed = await ok("PATCH", path(room.id), { name: `${room.name}-renamed` }, alice.token);
    expect(renamed.name).toBe(`${room.name}-renamed`);
    // An ordinary member of the channel cannot rename or delete it.
    expect((await req("PATCH", path(room.id), { name: "nope" }, bob.token)).status).toBe(403);
    expect((await req("DELETE", path(room.id), undefined, bob.token)).status).toBe(403);
    await ok("DELETE", path(room.id), undefined, alice.token);
    expect(await listed(alice, room.id)).toBeNull();
  });

  test("the workspace owner cannot touch a private channel they are not in", async () => {
    const room = await privateChannel(alice, [bob]);
    const refused = [
      await req("PATCH", path(room.id), { name: "mine-now" }, owner.token),
      await req("PATCH", path(room.id), { isPrivate: false }, owner.token),
      await req("DELETE", path(room.id), undefined, owner.token),
      await req("POST", path(room.id, "/members"), { userIds: [owner.id] }, owner.token),
      await req("DELETE", path(room.id, `/members/${bob.id}`), undefined, owner.token),
      await req("PATCH", path(room.id, `/members/${bob.id}`), { role: "admin" }, owner.token),
    ];
    expect(refused.map((response) => response.status)).toEqual([403, 403, 403, 403, 403, 403]);
    expect(members(await listed(alice, room.id))).toEqual({ [alice.id]: "admin", [bob.id]: "member" });
  });

  test("a workspace owner who is in the channel can manage it without being its admin", async () => {
    const room = await privateChannel(alice, [owner, bob]);
    expect(members(room.channel)[owner.id]).toBe("member");
    await ok("DELETE", path(room.id, `/members/${bob.id}`), undefined, owner.token);
    expect(Object.keys(members(await listed(alice, room.id))).sort()).toEqual([alice.id, owner.id].sort());
  });
});

describe("members", () => {
  test("any member adds people; they get the channel live, with its history", async () => {
    const room = await privateChannel(alice, [bob]);
    const secret = await ok("POST", `/messages/${room.id}`, { content: `before carol ${run}` }, alice.token);
    const aliceSocket = await connect(alice.token);
    const carolSocket = await connect(carol.token);
    const ownerSocket = await connect(owner.token);

    // Bob is an ordinary member of the channel.
    const updated = await ok("POST", path(room.id, "/members"), { userIds: [carol.id] }, bob.token);
    expect(members(updated)).toEqual({ [alice.id]: "admin", [bob.id]: "member", [carol.id]: "member" });

    await until(
      () => carolSocket.events.some((event) => event.type === "channel_joined" && event.channel.id === room.id),
      "channel_joined for the added member",
    );
    await until(
      () => aliceSocket.events.some((event) => event.type === "channel_updated" && event.channel.id === room.id),
      "channel_updated for an existing member",
    );
    const history = await ok("GET", `/messages/${room.id}`, undefined, carol.token);
    expect(history.map((message: any) => message.id)).toContain(secret.id);
    expect((await listed(carol, room.id)).isPrivate).toBe(true);

    // Adding someone twice changes nothing.
    const again = await ok("POST", path(room.id, "/members"), { userIds: [carol.id] }, alice.token);
    expect(Object.keys(members(again))).toHaveLength(3);

    // The owner, connected throughout, heard nothing about this channel.
    const barrier = await ok("POST", `/messages/${generalId}`, { content: `barrier ${run} add` }, alice.token);
    await until(
      () => ownerSocket.events.some((event) => event.type === "new_message" && event.message.id === barrier.id),
      "the public barrier on the owner's socket",
    );
    expect(JSON.stringify(ownerSocket.events)).not.toContain(room.id);
  });

  test("only workspace members can be added, and only to private channels", async () => {
    const room = await privateChannel(alice, []);
    const stranger = await register(`Stranger ${run}`);
    expect((await req("POST", path(room.id, "/members"), { userIds: [stranger.id] }, alice.token)).status).toBe(400);
    expect((await req("POST", path(room.id, "/members"), { userIds: [] }, alice.token)).status).toBe(400);
    expect((await req("POST", path(generalId, "/members"), { userIds: [bob.id] }, owner.token)).status).toBe(400);
    expect((await req("DELETE", path(generalId, `/members/${bob.id}`), undefined, owner.token)).status).toBe(400);
    // Someone outside the channel cannot add anyone, themselves included.
    expect((await req("POST", path(room.id, "/members"), { userIds: [bob.id] }, bob.token)).status).toBe(403);
    expect(Object.keys(members(await listed(alice, room.id)))).toEqual([alice.id]);
  });

  test("removal takes an admin; the removed person loses the channel, its unread and its threads", async () => {
    const room = await privateChannel(alice, [bob, carol]);
    const root = await ok("POST", `/messages/${room.id}`, { content: `thread root ${run}` }, alice.token);
    await ok("POST", `/messages/${room.id}`, { content: "reply from carol", parentMessageId: root.id }, carol.token);
    await ok("POST", "/activity/read-all", {}, carol.token);
    const unreadWord = `unreadword${run}`;
    await ok("POST", `/messages/${room.id}`, { content: `${unreadWord} for carol` }, alice.token);
    await ok("POST", `/messages/${room.id}`, { content: "thread reply for carol", parentMessageId: root.id }, alice.token);
    const before = await ok("GET", "/activity", undefined, carol.token);
    expect(before.totalUnreadMessages).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(await ok("GET", "/activity/threads", undefined, carol.token))).toContain(root.id);

    // Bob is an ordinary member: he cannot remove Carol.
    expect((await req("DELETE", path(room.id, `/members/${carol.id}`), undefined, bob.token)).status).toBe(403);

    const carolSocket = await connect(carol.token);
    const bobSocket = await connect(bob.token);
    const removed = await ok("DELETE", path(room.id, `/members/${carol.id}`), undefined, alice.token);
    expect(removed.channelDeleted).toBe(false);
    expect(members(removed.channel)).toEqual({ [alice.id]: "admin", [bob.id]: "member" });
    await until(
      () => carolSocket.events.some((event) => event.type === "channel_deleted" && event.channelId === room.id),
      "channel_deleted for the removed member",
    );
    await until(
      () => bobSocket.events.some((event) => event.type === "channel_updated" && event.channel.id === room.id),
      "channel_updated for the remaining member",
    );

    expect(await listed(carol, room.id)).toBeNull();
    expect((await req("GET", `/messages/${room.id}`, undefined, carol.token)).status).toBe(403);
    expect((await req("POST", `/messages/${room.id}`, { content: "still here?" }, carol.token)).status).toBe(403);
    expect((await req("GET", `/messages/${room.id}/threads/${root.id}`, undefined, carol.token)).status).toBe(403);
    const after = await ok("GET", "/activity", undefined, carol.token);
    expect(after.totalUnreadMessages).toBe(before.totalUnreadMessages - 2);
    expect(JSON.stringify(after)).not.toContain(unreadWord);
    expect(JSON.stringify(await ok("GET", "/activity/threads", undefined, carol.token))).not.toContain(root.id);
    expect((await ok("GET", `/search/messages?q=${unreadWord}`, undefined, carol.token)).results).toEqual([]);

    // Later messages reach members only.
    const later = await ok("POST", `/messages/${room.id}`, { content: `after removal ${run}` }, alice.token);
    const barrier = await ok("POST", `/messages/${generalId}`, { content: `barrier ${run} remove` }, alice.token);
    await until(
      () => carolSocket.events.some((event) => event.type === "new_message" && event.message.id === barrier.id),
      "the public barrier on the removed member's socket",
    );
    expect(carolSocket.events.some((event) => event.type === "new_message" && event.message.id === later.id)).toBe(false);
    // Removing someone who is not in the channel is an error, not a no-op.
    expect((await req("DELETE", path(room.id, `/members/${carol.id}`), undefined, alice.token)).status).toBe(404);
  });

  test("anyone can leave; when the last admin leaves, the longest-standing member takes over", async () => {
    const room = await privateChannel(alice, [bob]);
    await ok("POST", path(room.id, "/members"), { userIds: [carol.id] }, alice.token);
    const left = await ok("DELETE", path(room.id, `/members/${alice.id}`), undefined, alice.token);
    expect(left.channelDeleted).toBe(false);
    expect(await listed(alice, room.id)).toBeNull();
    // Bob was in the channel before Carol.
    expect(members(await listed(bob, room.id))).toEqual({ [bob.id]: "admin", [carol.id]: "member" });
    await ok("PATCH", path(room.id), { name: `${room.name}-bob` }, bob.token);
  });

  test("when the last person leaves, the channel is deleted and its name is free again", async () => {
    const room = await privateChannel(alice, [bob]);
    await ok("POST", `/messages/${room.id}`, { content: "soon gone" }, alice.token);
    await ok("DELETE", path(room.id, `/members/${bob.id}`), undefined, bob.token);
    const last = await ok("DELETE", path(room.id, `/members/${alice.id}`), undefined, alice.token);
    expect(last).toMatchObject({ channelDeleted: true, channel: null });
    expect((await req("GET", `/conversations/detail/${room.id}`, undefined, alice.token)).status).toBe(403);
    const reused = await ok("POST", "/conversations/channel", { workspaceId, name: room.name }, owner.token);
    expect(reused.name).toBe(room.name);
    expect(reused.id).not.toBe(room.id);
  });

  test("a bot does not keep an otherwise empty channel alive", async () => {
    const bot = await ok("POST", "/bots/create", { name: `Agent ${run}`, kind: "hermes", workspaceId }, owner.token);
    createdBotUserIds.push(bot.userId);
    const room = await privateChannel(alice, []);
    const withBot = await ok("POST", path(room.id, "/members"), { userIds: [bot.userId] }, alice.token);
    expect(members(withBot)[bot.userId]).toBe("member");
    expect((await req("PATCH", path(room.id, `/members/${bot.userId}`), { role: "admin" }, alice.token)).status).toBe(400);
    const last = await ok("DELETE", path(room.id, `/members/${alice.id}`), undefined, alice.token);
    expect(last.channelDeleted).toBe(true);
    await ok("POST", "/conversations/channel", { workspaceId, name: room.name }, owner.token);
  });

  test("a channel created by a bot is run by a person in it, and needs one", async () => {
    const bot = await ok("POST", "/bots/create", { name: `Maker ${run}`, kind: "hermes", workspaceId }, owner.token);
    createdBotUserIds.push(bot.userId);
    const asBot = await mcp(bot.apiKey);
    try {
      const alone = await asBot.call("create_channel", { workspaceId, name: `botonly-${run}`, isPrivate: true });
      expect(alone.isError).toBe(true);
      expect(alone.text).toBe("A private channel needs at least one person");
      const made = await asBot.call("create_channel", {
        workspaceId, name: `botmade-${run}`, isPrivate: true, memberIds: [bob.id],
      });
      expect(made.isError, made.text).toBe(false);
      expect(members(made.json)[bob.id]).toBe("admin");
      await ok("PATCH", path(made.json.id), { name: `botmade-${run}-renamed` }, bob.token);
    } finally {
      await asBot.close();
    }
    // The refused channel left nothing behind: its name is free.
    await ok("POST", "/conversations/channel", { workspaceId, name: `botonly-${run}` }, owner.token);
  });

  test("admins can be appointed, and a channel always keeps one", async () => {
    const room = await privateChannel(alice, [bob]);
    expect((await req("PATCH", path(room.id, `/members/${alice.id}`), { role: "member" }, alice.token)).status).toBe(400);
    expect((await req("PATCH", path(room.id, `/members/${bob.id}`), { role: "admin" }, bob.token)).status).toBe(403);
    const promoted = await ok("PATCH", path(room.id, `/members/${bob.id}`), { role: "admin" }, alice.token);
    expect(members(promoted)).toEqual({ [alice.id]: "admin", [bob.id]: "admin" });
    const demoted = await ok("PATCH", path(room.id, `/members/${alice.id}`), { role: "member" }, bob.token);
    expect(members(demoted)).toEqual({ [alice.id]: "member", [bob.id]: "admin" });
    expect((await req("PATCH", path(room.id, `/members/${carol.id}`), { role: "admin" }, bob.token)).status).toBe(404);
  });
});

describe("leaving the workspace", () => {
  test("a channel whose only member is removed from the workspace is deleted; a channel that loses its admin gets a new one", async () => {
    const dave = await register(`Dave ${run}`);
    await join(dave);
    const solo = await privateChannel(dave, []);
    // People picked at creation joined at the same instant, so Carol is
    // added afterwards to make Bob the longest-standing member.
    const shared = await privateChannel(dave, [bob]);
    await ok("POST", path(shared.id, "/members"), { userIds: [carol.id] }, dave.token);
    const bobSocket = await connect(bob.token);

    // The owner removes Dave without being able to see either channel.
    await ok("DELETE", `/workspaces/${workspaceId}/members/${dave.id}`, undefined, owner.token);

    await until(
      () => bobSocket.events.some((event) => event.type === "channel_updated" && event.channel.id === shared.id),
      "channel_updated after the admin left the workspace",
    );
    expect(members(await listed(bob, shared.id))).toEqual({ [bob.id]: "admin", [carol.id]: "member" });
    const reused = await ok("POST", "/conversations/channel", { workspaceId, name: solo.name }, owner.token);
    expect(reused.id).not.toBe(solo.id);
  });
});

describe("visibility", () => {
  test("making a channel public adds the whole workspace; only its admin may do it", async () => {
    const room = await privateChannel(alice, [bob]);
    const secret = await ok("POST", `/messages/${room.id}`, { content: `was private ${run}` }, alice.token);
    expect((await req("PATCH", path(room.id), { isPrivate: false }, bob.token)).status).toBe(403);
    const carolSocket = await connect(carol.token);

    const opened = await ok("PATCH", path(room.id), { isPrivate: false }, alice.token);
    expect(opened.isPrivate).toBe(false);
    expect(opened.members).toBeUndefined();
    await until(
      () => carolSocket.events.some((event) => event.type === "channel_joined" && event.channel.id === room.id),
      "channel_joined when a channel becomes public",
    );
    const history = await ok("GET", `/messages/${room.id}`, undefined, carol.token);
    expect(history.map((message: any) => message.id)).toContain(secret.id);
    expect((await listed(owner, room.id)).isPrivate).toBe(false);
    // It is an ordinary public channel now: workspace managers manage it.
    expect((await req("PATCH", path(room.id), { name: "alice-again" }, alice.token)).status).toBe(403);
    await ok("PATCH", path(room.id), { name: `${room.name}-public` }, owner.token);
    // Someone who joins later is in it, like any public channel.
    const late = await register(`Late ${run}`);
    await join(late);
    expect(await listed(late, room.id)).not.toBeNull();
  });

  test("making a channel private keeps its members and closes it to newcomers", async () => {
    const name = `open-${run}`;
    const open = await ok("POST", "/conversations/channel", { workspaceId, name }, alice.token);
    // Alice created it, but public channels belong to workspace managers.
    expect((await req("PATCH", path(open.id), { isPrivate: true }, alice.token)).status).toBe(403);
    const closed = await ok("PATCH", path(open.id), { isPrivate: true }, owner.token);
    expect(closed.isPrivate).toBe(true);
    expect(members(closed)[owner.id]).toBe("admin");
    expect(members(closed)[alice.id]).toBe("member");
    expect(members(closed)[bob.id]).toBe("member");

    const newcomer = await register(`Newcomer ${run}`);
    await join(newcomer);
    expect(await listed(newcomer, open.id)).toBeNull();
    expect((await req("GET", `/messages/${open.id}`, undefined, newcomer.token)).status).toBe(403);
    expect(await listed(alice, open.id)).not.toBeNull();
    // Same value again is a no-op, not an error.
    await ok("PATCH", path(open.id), { isPrivate: true }, owner.token);
    expect((await req("PATCH", path(open.id), {}, owner.token)).status).toBe(400);
  });

  test("the general channel stays public", async () => {
    const response = await req("PATCH", path(generalId), { isPrivate: true }, owner.token);
    expect(response.status).toBe(400);
    expect((await listed(carol, generalId)).isPrivate).toBe(false);
  });

  test("a workspace keeps at least one public channel, whatever it is called", async () => {
    const solo = await register(`Solo ${run}`);
    const workspace = await ok("POST", "/workspaces/create", { name: `Solo ${run}` }, solo.token);
    createdWorkspaceIds.push(workspace.id);
    const [only] = (await ok("GET", `/workspaces/${workspace.id}`, undefined, solo.token)).channels;
    await ok("PATCH", path(only.id), { name: "lobby" }, solo.token);
    const refused = await req("PATCH", path(only.id), { isPrivate: true }, solo.token);
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe("A workspace needs at least one public channel");
    // With a second public channel the renamed one may go private.
    await ok("POST", "/conversations/channel", { workspaceId: workspace.id, name: "second" }, solo.token);
    expect((await ok("PATCH", path(only.id), { isPrivate: true }, solo.token)).isPrivate).toBe(true);
  });
});

describe("MCP tools follow the same rules", () => {
  test("add_channel_members, remove_channel_member and update_channel", async () => {
    const room = await privateChannel(alice, []);
    const asAlice = await mcp(alice.token);
    const asOwner = await mcp(owner.token);
    try {
      const refused = await asOwner.call("add_channel_members", { conversationId: room.id, userIds: [owner.id] });
      expect(refused.isError).toBe(true);
      expect((await asOwner.call("update_channel", { conversationId: room.id, isPrivate: false })).isError).toBe(true);

      const added = await asAlice.call("add_channel_members", { conversationId: room.id, userIds: [bob.id] });
      expect(added.isError, added.text).toBe(false);
      expect(members(added.json)).toEqual({ [alice.id]: "admin", [bob.id]: "member" });

      const removed = await asAlice.call("remove_channel_member", { conversationId: room.id, userId: bob.id });
      expect(removed.isError, removed.text).toBe(false);
      expect(removed.json.channelDeleted).toBe(false);

      const renamed = await asAlice.call("update_channel", { conversationId: room.id, name: `${room.name}-mcp`, isPrivate: false });
      expect(renamed.isError, renamed.text).toBe(false);
      expect(renamed.json).toMatchObject({ name: `${room.name}-mcp`, isPrivate: false });
      expect(await listed(carol, room.id)).not.toBeNull();
      expect((await asAlice.call("update_channel", { conversationId: room.id })).isError).toBe(true);
    } finally {
      await asAlice.close();
      await asOwner.close();
    }
  });
});
