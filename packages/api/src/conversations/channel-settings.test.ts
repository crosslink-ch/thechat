import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { Elysia } from "elysia";
import { activityRoutes } from "../activity";
import { queueJobs } from "../async/job-schema";
import { authRoutes } from "../auth";
import { botRequestRoutes } from "../bot-requests";
import { botRoutes } from "../bots";
import { db } from "../db";
import { botInvocations, botRequests, users, workspaces } from "../db/schema";
import { inviteRoutes } from "../invites";
import { messageRoutes } from "../messages";
import { searchRoutes } from "../search";
import { setChannelArchived } from "../services/conversations";
import { sendMessage } from "../services/messages";
import { workspaceRoutes } from "../workspaces";
import { wsRoutes } from "../ws";
import { conversationRoutes } from ".";

/**
 * Channel settings: the member list, adding and removing people in a private
 * channel, and archiving. One real server and real sockets, so "at once,
 * without reload" is checked on what a connected client actually receives.
 *
 * The permission rule is the one private channels use for rename and delete:
 * a workspace owner or admin who is in the channel.
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
  const email = `settings-${crypto.randomUUID()}@example.invalid`;
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

/**
 * A public message sent after the thing under test: once a socket has it,
 * everything published before it would have arrived on that socket too.
 */
async function barrier(sockets: Array<{ events: any[] }>) {
  const message = await ok("POST", `/messages/${generalId}`, { content: `barrier ${crypto.randomUUID()}` }, owner.token);
  for (const socket of sockets) {
    await until(
      () => socket.events.some((event) => event.type === "new_message" && event.message.id === message.id),
      "the public barrier message",
    );
  }
}

const mentions = (events: any[], needle: string) => events.filter((event) => JSON.stringify(event).includes(needle));

let owner: Person;
let admin: Person;
let hiddenAdmin: Person;
let member: Person;
let outsider: Person;
let stranger: Person;
let bot: { id: string; userId: string; apiKey: string };
let workspaceId: string;
let generalId: string;

async function createPrivateChannel(name: string, memberIds: string[]) {
  const channel = await ok(
    "POST",
    "/conversations/channel",
    { workspaceId, name: `${name}-${run}-${crypto.randomUUID().slice(0, 4)}`, isPrivate: true, memberIds },
    owner.token,
  );
  return channel.id as string;
}

const memberIdsOf = async (channelId: string, token: string) =>
  (await ok("GET", `/conversations/detail/${channelId}`, undefined, token)).participants
    .map((participant: any) => participant.userId)
    .sort();

beforeAll(async () => {
  owner = await register(`Owner ${run}`);
  admin = await register(`Admin ${run}`);
  hiddenAdmin = await register(`Hidden Admin ${run}`);
  member = await register(`Member ${run}`);
  outsider = await register(`Outsider ${run}`);
  stranger = await register(`Stranger ${run}`);
  const workspace = await ok("POST", "/workspaces/create", { name: `Settings ${run}` }, owner.token);
  workspaceId = workspace.id;
  createdWorkspaceIds.push(workspaceId);
  for (const person of [admin, hiddenAdmin, member, outsider]) {
    const invite = await ok("POST", "/invites/create", { workspaceId, email: person.email }, owner.token);
    await ok("POST", "/invites/accept", { inviteId: invite.id }, person.token);
  }
  for (const person of [admin, hiddenAdmin]) {
    await ok("POST", `/workspaces/${workspaceId}/members/${person.id}/role`, { role: "admin" }, owner.token);
  }
  bot = await ok("POST", "/bots/create", { name: `Agent ${run}`, kind: "hermes", workspaceId }, owner.token);
  createdBotUserIds.push(bot.userId);
  generalId = (await ok("GET", `/workspaces/${workspaceId}`, undefined, owner.token)).channels[0].id;
});

afterAll(async () => {
  for (const socket of openSockets) socket.close();
  app.stop();
  const humans = createdEmails.length
    ? await db.select({ id: users.id }).from(users).where(inArray(users.email, createdEmails))
    : [];
  const actorIds = [...createdBotUserIds, ...humans.map((user) => user.id)];
  // Sending messages queues jobs; leave none behind for other test files.
  if (actorIds.length) await db.delete(queueJobs).where(inArray(queueJobs.actorId, actorIds));
  if (createdWorkspaceIds.length) {
    await db.delete(queueJobs).where(inArray(queueJobs.tenantId, createdWorkspaceIds));
    await db.delete(workspaces).where(inArray(workspaces.id, createdWorkspaceIds));
  }
  if (createdBotUserIds.length) await db.delete(users).where(inArray(users.id, createdBotUserIds));
  for (const email of createdEmails) await db.delete(users).where(eq(users.email, email));
});

describe("channel details", () => {
  test("a member sees name, visibility and every member with their current workspace role", async () => {
    const channelId = await createPrivateChannel("details", [admin.id, member.id, bot.userId]);
    const detail = await ok("GET", `/conversations/detail/${channelId}`, undefined, member.token);
    expect(detail).toMatchObject({ id: channelId, type: "group", isPrivate: true, archivedAt: null });
    expect(
      detail.participants.map((participant: any) => [participant.user.name, participant.role, participant.user.type]).sort(),
    ).toEqual(
      [
        [admin.name, "admin", "human"],
        [`Agent ${run}`, "member", "bot"],
        [member.name, "member", "human"],
        [owner.name, "owner", "human"],
      ].sort(),
    );

    // A role change in the workspace shows in the channel's member list.
    await ok("POST", `/workspaces/${workspaceId}/members/${member.id}/role`, { role: "admin" }, owner.token);
    try {
      const promoted = await ok("GET", `/conversations/detail/${channelId}`, undefined, owner.token);
      expect(promoted.participants.find((participant: any) => participant.userId === member.id).role).toBe("admin");
    } finally {
      await ok("POST", `/workspaces/${workspaceId}/members/${member.id}/role`, { role: "member" }, owner.token);
    }

    // Workspace members who are not in the channel, admins included, get nothing.
    for (const person of [outsider, hiddenAdmin, stranger]) {
      expect((await req("GET", `/conversations/detail/${channelId}`, undefined, person.token)).status).toBe(403);
    }
    expect((await req("GET", `/conversations/detail/${channelId}`)).status).toBe(401);
  });

  test("a public channel lists everyone and its member list cannot be edited, even by the owner", async () => {
    const detail = await ok("GET", `/conversations/detail/${generalId}`, undefined, member.token);
    expect(detail.isPrivate).toBe(false);
    expect(detail.participants.map((participant: any) => participant.userId).sort()).toEqual(
      [owner.id, admin.id, hiddenAdmin.id, member.id, outsider.id, bot.userId].sort(),
    );

    const added = await req("POST", `/conversations/channel/${generalId}/members`, { userIds: [member.id] }, owner.token);
    expect(added.status).toBe(400);
    const removed = await req("DELETE", `/conversations/channel/${generalId}/members/${member.id}`, undefined, owner.token);
    expect(removed.status).toBe(400);
    expect(await memberIdsOf(generalId, owner.token)).toContain(member.id);
  });
});

describe("who may add people, remove people, archive and unarchive", () => {
  test("only a workspace owner or admin who is in the channel", async () => {
    const channelId = await createPrivateChannel("perms", [admin.id, member.id]);
    const actions = (target: Person) => [
      ["POST", `/conversations/channel/${channelId}/members`, { userIds: [target.id] }],
      ["DELETE", `/conversations/channel/${channelId}/members/${member.id}`, undefined],
      ["POST", `/conversations/channel/${channelId}/archive`, undefined],
      ["POST", `/conversations/channel/${channelId}/unarchive`, undefined],
    ] as const;

    const refusedCallers = [
      { who: "signed out", token: undefined, status: 401 },
      { who: "not in the workspace", token: stranger.token, status: 403 },
      { who: "workspace member outside the channel", token: outsider.token, status: 403 },
      { who: "workspace admin outside the channel", token: hiddenAdmin.token, status: 403 },
      { who: "regular member of the channel", token: member.token, status: 403 },
      { who: "bot outside the channel", token: bot.apiKey, status: 403 },
    ];
    for (const caller of refusedCallers) {
      for (const [method, path, body] of actions(outsider)) {
        const response = await req(method, path, body, caller.token);
        expect(response.status, `${caller.who}: ${method} ${path}`).toBe(caller.status);
      }
    }
    // Nothing above changed the channel.
    expect(await memberIdsOf(channelId, owner.token)).toEqual([owner.id, admin.id, member.id].sort());
    expect((await ok("GET", `/conversations/detail/${channelId}`, undefined, owner.token)).archivedAt).toBeNull();

    // An admin who is in the channel can do all four.
    await ok("POST", `/conversations/channel/${channelId}/members`, { userIds: [outsider.id] }, admin.token);
    await ok("DELETE", `/conversations/channel/${channelId}/members/${outsider.id}`, undefined, admin.token);
    expect((await ok("POST", `/conversations/channel/${channelId}/archive`, undefined, admin.token)).archivedAt).toEqual(
      expect.any(String),
    );
    expect((await ok("POST", `/conversations/channel/${channelId}/unarchive`, undefined, admin.token)).archivedAt).toBeNull();
    // So can the owner.
    await ok("POST", `/conversations/channel/${channelId}/members`, { userIds: [outsider.id] }, owner.token);
    await ok("DELETE", `/conversations/channel/${channelId}/members/${outsider.id}`, undefined, owner.token);
    await ok("POST", `/conversations/channel/${channelId}/archive`, undefined, owner.token);
    await ok("POST", `/conversations/channel/${channelId}/unarchive`, undefined, owner.token);

    // An admin added to the channel later gains the right with membership.
    await ok("POST", `/conversations/channel/${channelId}/members`, { userIds: [hiddenAdmin.id] }, owner.token);
    await ok("POST", `/conversations/channel/${channelId}/members`, { userIds: [outsider.id] }, hiddenAdmin.token);
    expect(await memberIdsOf(channelId, owner.token)).toEqual(
      [owner.id, admin.id, hiddenAdmin.id, member.id, outsider.id].sort(),
    );
  });

  test("removal follows the workspace hierarchy and never targets yourself", async () => {
    const channelId = await createPrivateChannel("hierarchy", [admin.id, hiddenAdmin.id, member.id]);
    const remove = (targetId: string, token: string) =>
      req("DELETE", `/conversations/channel/${channelId}/members/${targetId}`, undefined, token);

    expect((await remove(owner.id, admin.token)).status).toBe(403);
    expect((await remove(hiddenAdmin.id, admin.token)).status).toBe(403);
    expect((await remove(admin.id, admin.token)).status).toBe(400);
    expect((await remove(owner.id, owner.token)).status).toBe(400);
    // Someone who is not in the channel, and an id that is no one.
    expect((await remove(outsider.id, owner.token)).status).toBe(404);
    expect((await remove(crypto.randomUUID(), owner.token)).status).toBe(404);
    expect(await memberIdsOf(channelId, owner.token)).toEqual([owner.id, admin.id, hiddenAdmin.id, member.id].sort());

    // The owner may remove an admin; an admin may remove a regular member.
    expect((await remove(hiddenAdmin.id, owner.token)).status).toBe(200);
    expect((await remove(member.id, admin.token)).status).toBe(200);
    expect(await memberIdsOf(channelId, owner.token)).toEqual([owner.id, admin.id].sort());
  });

  test("only workspace members can be added", async () => {
    const channelId = await createPrivateChannel("workspace-only", [admin.id]);
    const add = (userIds: unknown) => req("POST", `/conversations/channel/${channelId}/members`, { userIds }, owner.token);

    // One stranger spoils the whole request: nobody is added.
    expect((await add([outsider.id, stranger.id])).status).toBe(400);
    expect((await add([crypto.randomUUID()])).status).toBe(400);
    expect((await add([])).status).toBe(400);
    expect((await add(["not-a-uuid"])).status).toBe(400);
    expect(await memberIdsOf(channelId, owner.token)).toEqual([owner.id, admin.id].sort());
    expect((await req("GET", `/conversations/detail/${channelId}`, undefined, stranger.token)).status).toBe(403);
    expect((await req("POST", `/conversations/channel/${crypto.randomUUID()}/members`, { userIds: [outsider.id] }, owner.token)).status).toBe(404);
  });
});

describe("adding and removing people takes effect at once", () => {
  test("an added member gets the channel live and can read its earlier history", async () => {
    const channelId = await createPrivateChannel("adding", [admin.id]);
    const word = `heron${run}`;
    const earlier = await ok("POST", `/messages/${channelId}`, { content: `Decided before you joined: ${word}` }, owner.token);

    const ownerSocket = await connect(owner.token);
    const adminSocket = await connect(admin.token);
    const memberSocket = await connect(member.token);
    const outsiderSocket = await connect(outsider.token);

    // Before: the channel does not exist as far as the member can tell.
    expect((await ok("GET", `/workspaces/${workspaceId}`, undefined, member.token)).channels.map((c: any) => c.id)).not.toContain(channelId);
    expect((await ok("GET", `/search/messages?q=${word}`, undefined, member.token)).results).toEqual([]);

    const result = await ok("POST", `/conversations/channel/${channelId}/members`, { userIds: [member.id, bot.userId] }, admin.token);
    expect(result.addedUserIds.sort()).toEqual([member.id, bot.userId].sort());
    await barrier([ownerSocket, adminSocket, memberSocket, outsiderSocket]);

    // The new member's open client is handed the channel itself.
    const forMember = memberSocket.events.find((event) => event.type === "channel_members_added");
    expect(forMember).toMatchObject({
      workspaceId,
      channel: { id: channelId, isPrivate: true, archivedAt: null },
    });
    expect(forMember.userIds.sort()).toEqual([member.id, bot.userId].sort());
    // Existing members hear about it; everyone else in the workspace does not.
    expect(ownerSocket.events.some((event) => event.type === "channel_members_added")).toBe(true);
    expect(adminSocket.events.some((event) => event.type === "channel_members_added")).toBe(true);
    expect(mentions(outsiderSocket.events, channelId)).toEqual([]);

    // Listing, history, search, posting and live delivery all work for them now.
    expect((await ok("GET", `/workspaces/${workspaceId}`, undefined, member.token)).channels.map((c: any) => c.id)).toContain(channelId);
    expect((await ok("GET", `/messages/${channelId}`, undefined, member.token)).map((m: any) => m.id)).toEqual([earlier.id]);
    expect((await ok("GET", `/search/messages?q=${word}`, undefined, member.token)).results.map((hit: any) => hit.id)).toEqual([earlier.id]);
    const reply = await ok("POST", `/messages/${channelId}`, { content: "Thanks for adding me" }, member.token);
    const fromOwner = await ok("POST", `/messages/${channelId}`, { content: "Welcome" }, owner.token);
    await until(
      () => memberSocket.events.some((event) => event.type === "new_message" && event.message.id === fromOwner.id),
      "the new member receiving a message live",
    );
    expect(ownerSocket.events.some((event) => event.type === "new_message" && event.message.id === reply.id)).toBe(true);
    // The bot that was added can post with its own key.
    expect((await req("POST", `/messages/${channelId}`, { content: "agent here" }, bot.apiKey)).status).toBe(200);

    // Adding someone who is already in changes nothing and announces nothing.
    const before = ownerSocket.events.length;
    const again = await ok("POST", `/conversations/channel/${channelId}/members`, { userIds: [member.id] }, owner.token);
    expect(again.addedUserIds).toEqual([]);
    await barrier([ownerSocket]);
    expect(ownerSocket.events.slice(before).some((event) => event.type === "channel_members_added")).toBe(false);
  });

  test("a removed member loses the channel at once: events, reads, writes, search and unread counts", async () => {
    const channelId = await createPrivateChannel("removing", [admin.id, member.id, bot.userId]);
    const word = `osprey${run}`;
    const root = await ok("POST", `/messages/${channelId}`, { content: `Plan ${word}` }, owner.token);
    // The member follows a thread and has an unread message here.
    await ok("POST", `/messages/${channelId}`, { content: "I will take it", parentMessageId: root.id }, member.token);
    await ok("POST", `/messages/${channelId}`, { content: `Unread for the member ${word}` }, owner.token);
    const unreadBefore = await ok("GET", "/activity", undefined, member.token);
    expect(unreadBefore.items.map((item: any) => item.conversationId)).toContain(channelId);

    const ownerSocket = await connect(owner.token);
    const memberSocket = await connect(member.token);

    const removed = await ok("DELETE", `/conversations/channel/${channelId}/members/${member.id}`, undefined, admin.token);
    expect(removed).toEqual({ ok: true, removedUserId: member.id });
    await until(
      () => memberSocket.events.some((event) => event.type === "channel_member_removed"),
      "the removed member's client being told",
    );
    expect(memberSocket.events.find((event) => event.type === "channel_member_removed")).toEqual({
      type: "channel_member_removed",
      workspaceId,
      channelId,
      userId: member.id,
    });
    expect(ownerSocket.events.some((event) => event.type === "channel_member_removed" && event.userId === member.id)).toBe(true);

    // What is said after the removal never reaches the socket that is still open.
    const cutoff = memberSocket.events.length;
    const after = await ok("POST", `/messages/${channelId}`, { content: `After removal ${word}` }, owner.token);
    await ok("POST", `/messages/${channelId}`, { content: "thread goes on", parentMessageId: root.id }, owner.token);
    await ok("POST", `/messages/${channelId}/${after.id}/reactions`, { emoji: "👍", active: true }, admin.token);
    await barrier([memberSocket, ownerSocket]);
    expect(mentions(memberSocket.events.slice(cutoff), channelId)).toEqual([]);
    expect(ownerSocket.events.some((event) => event.type === "new_message" && event.message.id === after.id)).toBe(true);

    // Every door is shut, exactly as for someone who was never in the channel.
    const refused = [
      await req("GET", `/conversations/detail/${channelId}`, undefined, member.token),
      await req("GET", `/messages/${channelId}`, undefined, member.token),
      await req("POST", `/messages/${channelId}`, { content: "still here?" }, member.token),
      await req("GET", `/messages/${channelId}/threads/${root.id}`, undefined, member.token),
      await req("POST", `/messages/${channelId}`, { content: "reply", parentMessageId: root.id }, member.token),
      await req("POST", `/messages/${channelId}/${root.id}/reactions`, { emoji: "👀", active: true }, member.token),
      await req("POST", `/activity/conversations/${channelId}/read`, { all: true }, member.token),
    ];
    expect(refused.map((response) => response.status)).toEqual(refused.map(() => 403));
    memberSocket.socket.send(
      JSON.stringify({ type: "send_message", conversationId: channelId, clientMessageId: `gone-${run}`, content: "over the socket" }),
    );
    await until(
      () => memberSocket.events.some((event) => event.type === "message_error" && event.clientMessageId === `gone-${run}`),
      "the socket send being refused",
    );
    expect((await ok("GET", `/messages/${channelId}`, undefined, owner.token)).map((m: any) => m.content)).not.toContain("over the socket");

    expect((await ok("GET", `/workspaces/${workspaceId}`, undefined, member.token)).channels.map((c: any) => c.id)).not.toContain(channelId);
    expect((await ok("GET", `/search/messages?q=${word}`, undefined, member.token)).results).toEqual([]);
    expect((await req("GET", `/search/messages?q=${word}&conversationId=${channelId}`, undefined, member.token)).status).toBe(404);
    const activity = await ok("GET", "/activity", undefined, member.token);
    expect(activity.items.map((item: any) => item.conversationId)).not.toContain(channelId);
    expect(JSON.stringify(await ok("GET", "/activity/threads", undefined, member.token))).not.toContain(root.id);

    // A removed bot is shut out the same way.
    await ok("DELETE", `/conversations/channel/${channelId}/members/${bot.userId}`, undefined, owner.token);
    expect((await req("GET", `/messages/${channelId}`, undefined, bot.apiKey)).status).toBe(403);
    expect((await req("POST", `/messages/${channelId}`, { content: "agent here" }, bot.apiKey)).status).toBe(403);

    // The remaining members keep everything.
    expect((await ok("GET", `/search/messages?q=${word}`, undefined, admin.token)).results.length).toBe(3);
    expect(await memberIdsOf(channelId, owner.token)).toEqual([owner.id, admin.id].sort());

    // Added back, they see the whole history again, including what they missed.
    await ok("POST", `/conversations/channel/${channelId}/members`, { userIds: [member.id] }, owner.token);
    await until(
      () => memberSocket.events.slice(cutoff).some((event) => event.type === "channel_members_added"),
      "the channel coming back for the re-added member",
    );
    expect((await ok("GET", `/messages/${channelId}`, undefined, member.token)).map((m: any) => m.id)).toContain(after.id);
  });
});

describe("what a removed member left unfinished", () => {
  test("a removed bot's run and open request are closed, so the channel can still be archived and deleted", async () => {
    const channelId = await createPrivateChannel("bot-leftovers", [member.id, bot.userId]);
    const trigger = await ok("POST", `/messages/${channelId}`, { content: "start working" }, owner.token);
    const [invocation] = await db
      .insert(botInvocations)
      .values({
        botId: bot.id,
        conversationId: channelId,
        triggerMessageId: trigger.id,
        adapterKind: "hermes",
        status: "running",
        requestJson: {},
        startedAt: new Date(),
      })
      .returning({ id: botInvocations.id });
    const asked = await req(
      "POST",
      "/bot-requests",
      {
        clientKey: `leftover-${crypto.randomUUID()}`,
        kind: "approval",
        title: "Deploy?",
        conversationId: channelId,
        response: { type: "choice", choices: ["yes", "no"] },
      },
      bot.apiKey,
    );
    expect(asked.status, JSON.stringify(asked.body)).toBe(201);
    const requestId = asked.body.request.id as string;
    await db.delete(queueJobs).where(eq(queueJobs.partitionKey, channelId));

    // The run blocks archiving while the bot is still a member.
    expect((await req("POST", `/conversations/channel/${channelId}/archive`, undefined, owner.token)).status).toBe(409);

    const memberSocket = await connect(member.token);
    await ok("DELETE", `/conversations/channel/${channelId}/members/${bot.userId}`, undefined, owner.token);

    const [run] = await db.select().from(botInvocations).where(eq(botInvocations.id, invocation.id));
    expect(run).toMatchObject({ status: "cancelled", error: "Bot removed from channel" });
    const [request] = await db.select().from(botRequests).where(eq(botRequests.id, requestId));
    expect(request.status).toBe("cancelled");
    // The card closes for the people still in the channel, and cannot be answered.
    await until(
      () =>
        memberSocket.events.some(
          (event) => event.type === "bot_request_updated" && event.request.id === requestId && event.request.status === "cancelled",
        ),
      "the cancelled request reaching members",
    );
    expect((await req("POST", `/bot-requests/${requestId}/answer`, { choice: "yes" }, member.token)).status).toBe(409);

    // Nothing is left to wait for.
    await ok("POST", `/conversations/channel/${channelId}/archive`, undefined, owner.token);
    await ok("DELETE", `/conversations/channel/${channelId}`, undefined, owner.token);
  });

  test("a request addressed to a removed person is closed; one for everyone stays open", async () => {
    const channelId = await createPrivateChannel("person-leftovers", [member.id, bot.userId]);
    const ask = async (audienceUserId?: string) => {
      const response = await req(
        "POST",
        "/bot-requests",
        {
          clientKey: `ask-${crypto.randomUUID()}`,
          kind: "approval",
          title: "Approve?",
          conversationId: channelId,
          response: { type: "choice", choices: ["yes", "no"] },
          ...(audienceUserId ? { audienceUserId } : {}),
        },
        bot.apiKey,
      );
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      return response.body.request.id as string;
    };
    const forMember = await ask(member.id);
    const forAnyone = await ask();

    await ok("DELETE", `/conversations/channel/${channelId}/members/${member.id}`, undefined, owner.token);

    const statusOf = async (id: string) =>
      (await db.select({ status: botRequests.status }).from(botRequests).where(eq(botRequests.id, id)))[0].status;
    expect(await statusOf(forMember)).toBe("cancelled");
    expect(await statusOf(forAnyone)).toBe("open");
    // The removed person cannot see or answer either of them.
    expect((await req("GET", `/bot-requests/${forAnyone}`, undefined, member.token)).status).toBe(404);
    expect((await req("POST", `/bot-requests/${forAnyone}/answer`, { choice: "yes" }, member.token)).status).toBe(404);
    expect((await req("POST", `/bot-requests/${forAnyone}/answer`, { choice: "yes" }, owner.token)).status).toBe(200);
  });
});

describe("archive and unarchive", () => {
  test("an archived channel is read-only for everyone and its history stays readable and searchable", async () => {
    const channelId = await createPrivateChannel("archive", [admin.id, member.id, bot.userId]);
    const word = `kingfisher${run}`;
    const root = await ok("POST", `/messages/${channelId}`, { content: `Final notes ${word}` }, owner.token);
    const reply = await ok("POST", `/messages/${channelId}`, { content: `Thread note ${word}`, parentMessageId: root.id }, member.token);

    const ownerSocket = await connect(owner.token);
    const memberSocket = await connect(member.token);
    const outsiderSocket = await connect(outsider.token);

    const archived = await ok("POST", `/conversations/channel/${channelId}/archive`, undefined, admin.token);
    expect(archived).toMatchObject({ id: channelId, isPrivate: true });
    expect(Date.parse(archived.archivedAt)).toBeGreaterThan(Date.now() - 60_000);
    await barrier([ownerSocket, memberSocket, outsiderSocket]);

    // Members are told live; the rest of the workspace learns nothing of a private channel.
    for (const socket of [ownerSocket, memberSocket]) {
      expect(socket.events.find((event) => event.type === "channel_updated")).toMatchObject({
        workspaceId,
        channel: { id: channelId, archivedAt: archived.archivedAt },
      });
    }
    expect(mentions(outsiderSocket.events, channelId)).toEqual([]);

    // Still listed for its members (flagged), still readable, still searchable.
    const listed = (await ok("GET", `/workspaces/${workspaceId}`, undefined, member.token)).channels.find((c: any) => c.id === channelId);
    expect(listed.archivedAt).toBe(archived.archivedAt);
    expect((await ok("GET", `/conversations/detail/${channelId}`, undefined, member.token)).archivedAt).toBe(archived.archivedAt);
    expect((await ok("GET", `/messages/${channelId}`, undefined, member.token)).map((m: any) => m.id)).toEqual([root.id]);
    expect((await ok("GET", `/messages/${channelId}/threads/${root.id}`, undefined, member.token)).replies.map((m: any) => m.id)).toEqual([reply.id]);
    expect((await ok("GET", `/search/messages?q=${word}`, undefined, member.token)).results.map((hit: any) => hit.id).sort()).toEqual(
      [root.id, reply.id].sort(),
    );
    expect((await ok("GET", `/search/messages/${root.id}/context`, undefined, member.token)).targetMessageId).toBe(root.id);
    const directory = (await ok("GET", "/search/directory", undefined, member.token)).destinations;
    expect(directory.filter((entry: any) => entry.kind === "channel").map((entry: any) => entry.conversationId)).toContain(channelId);
    // Reading it can still be recorded, so an unread dot does not stick forever.
    expect((await req("POST", `/activity/conversations/${channelId}/read`, { all: true }, member.token)).status).toBe(200);

    // Nobody can write: not a member, not the owner who archived it, not a bot.
    const writes = [
      await req("POST", `/messages/${channelId}`, { content: "one more thing" }, member.token),
      await req("POST", `/messages/${channelId}`, { content: "one more thing" }, owner.token),
      await req("POST", `/messages/${channelId}`, { content: "agent here" }, bot.apiKey),
      await req("POST", `/messages/${channelId}`, { content: "reply", parentMessageId: root.id }, member.token),
      await req("POST", `/messages/${channelId}/${root.id}/reactions`, { emoji: "👍", active: true }, member.token),
    ];
    expect(writes.map((response) => response.status)).toEqual(writes.map(() => 403));
    expect(writes[0].body.error).toContain("archived");
    // The same rule covers everything else that writes into a conversation.
    const otherWrites = [
      await req("POST", `/conversations/threads/${channelId}`, { botId: bot.id, title: "New task" }, member.token),
      await req("POST", `/conversations/projects/${channelId}`, { name: "New project" }, member.token),
      await req(
        "POST",
        "/bot-requests",
        {
          clientKey: `archived-${crypto.randomUUID()}`,
          kind: "approval",
          title: "Approve?",
          conversationId: channelId,
          response: { type: "choice", choices: ["yes", "no"] },
        },
        bot.apiKey,
      ),
    ];
    expect(otherWrites.map((response) => response.status)).toEqual([403, 403, 403]);
    memberSocket.socket.send(
      JSON.stringify({ type: "send_message", conversationId: channelId, clientMessageId: `arch-${run}`, content: "over the socket" }),
    );
    await until(
      () => memberSocket.events.some((event) => event.type === "message_error" && event.clientMessageId === `arch-${run}`),
      "the socket send being refused",
    );
    expect(memberSocket.events.find((event) => event.type === "message_error" && event.clientMessageId === `arch-${run}`).message).toContain(
      "archived",
    );
    expect((await req("PATCH", `/conversations/channel/${channelId}`, { name: `renamed-${run}` }, owner.token)).status).toBe(409);
    expect((await ok("GET", `/messages/${channelId}`, undefined, owner.token)).map((m: any) => m.id)).toEqual([root.id]);

    // Archiving twice is harmless and silent.
    const before = ownerSocket.events.length;
    expect((await ok("POST", `/conversations/channel/${channelId}/archive`, undefined, owner.token)).archivedAt).toBe(archived.archivedAt);
    await barrier([ownerSocket]);
    expect(ownerSocket.events.slice(before).some((event) => event.type === "channel_updated")).toBe(false);

    // Membership can still be managed while archived.
    await ok("DELETE", `/conversations/channel/${channelId}/members/${bot.userId}`, undefined, owner.token);

    // Unarchive: writing works again, live.
    const restored = await ok("POST", `/conversations/channel/${channelId}/unarchive`, undefined, owner.token);
    expect(restored.archivedAt).toBeNull();
    await until(
      () => memberSocket.events.some((event) => event.type === "channel_updated" && event.channel.archivedAt === null),
      "the unarchive reaching members",
    );
    const posted = await ok("POST", `/messages/${channelId}`, { content: "We are back" }, member.token);
    await until(
      () => ownerSocket.events.some((event) => event.type === "new_message" && event.message.id === posted.id),
      "a message in the unarchived channel",
    );
    expect((await req("PATCH", `/conversations/channel/${channelId}`, { name: `reopened-${run}` }, owner.token)).status).toBe(200);
  });

  test("a public channel can be archived; everyone is told and delete stays available", async () => {
    const channel = await ok("POST", "/conversations/channel", { workspaceId, name: `public-archive-${run}` }, owner.token);
    await ok("POST", `/messages/${channel.id}`, { content: "old news" }, member.token);
    const outsiderSocket = await connect(outsider.token);

    // A regular member cannot archive a public channel either.
    expect((await req("POST", `/conversations/channel/${channel.id}/archive`, undefined, member.token)).status).toBe(403);
    // An admin can, without any special membership: everyone is in a public channel.
    await ok("POST", `/conversations/channel/${channel.id}/archive`, undefined, hiddenAdmin.token);
    await until(
      () => outsiderSocket.events.some((event) => event.type === "channel_updated" && event.channel.id === channel.id),
      "everyone in the workspace hearing about a public archive",
    );
    expect((await req("POST", `/messages/${channel.id}`, { content: "too late" }, outsider.token)).status).toBe(403);
    expect((await ok("GET", `/messages/${channel.id}`, undefined, outsider.token)).map((m: any) => m.content)).toEqual(["old news"]);

    // Someone who joins the workspace later can read it, flagged as archived.
    const late = await register(`Late ${run}`);
    const invite = await ok("POST", "/invites/create", { workspaceId, email: late.email }, owner.token);
    await ok("POST", "/invites/accept", { inviteId: invite.id }, late.token);
    const forLate = (await ok("GET", `/workspaces/${workspaceId}`, undefined, late.token)).channels.find((c: any) => c.id === channel.id);
    expect(forLate.archivedAt).toEqual(expect.any(String));
    expect((await req("POST", `/messages/${channel.id}`, { content: "hello" }, late.token)).status).toBe(403);

    // Delete is the permanent option and works on an archived channel.
    expect((await req("DELETE", `/conversations/channel/${channel.id}`, undefined, member.token)).status).toBe(403);
    await ok("DELETE", `/conversations/channel/${channel.id}`, undefined, owner.token);
    expect((await ok("GET", `/workspaces/${workspaceId}`, undefined, owner.token)).channels.map((c: any) => c.id)).not.toContain(channel.id);
  });

  test("a message being sent while the channel is archived either lands first or is refused", async () => {
    const channelId = await createPrivateChannel("archive-race", [member.id]);

    // The archive holds the workspace lock; the send has to wait for it.
    let releaseArchive!: () => void;
    const archiveGate = new Promise<void>((resolve) => {
      releaseArchive = resolve;
    });
    let archiveLocked!: () => void;
    const archiveHasLock = new Promise<void>((resolve) => {
      archiveLocked = resolve;
    });
    const archiving = setChannelArchived(channelId, true, owner.id, {
      afterWorkspaceLocked: async () => {
        archiveLocked();
        await archiveGate;
      },
    });
    await archiveHasLock;

    let sendGotLock = false;
    const sending = sendMessage(channelId, member.id, member.name, "squeezed in?", {
      afterWorkspaceLocked: async () => {
        sendGotLock = true;
      },
    }).then(
      () => ({ sent: true as const }),
      (error: unknown) => ({ sent: false as const, error }),
    );
    await Bun.sleep(150);
    expect(sendGotLock).toBe(false);
    releaseArchive();
    await archiving;
    const outcome = await sending;
    expect(sendGotLock).toBe(true);
    expect(outcome.sent).toBe(false);
    if (!outcome.sent) expect(outcome.error).toMatchObject({ status: 403 });
    expect(await ok("GET", `/messages/${channelId}`, undefined, owner.token)).toEqual([]);
  });

  test("a channel with a bot run in progress cannot be archived until the run ends", async () => {
    const channelId = await createPrivateChannel("archive-run", [bot.userId]);
    const trigger = await ok("POST", `/messages/${channelId}`, { content: "start working" }, owner.token);
    const [invocation] = await db
      .insert(botInvocations)
      .values({
        botId: bot.id,
        conversationId: channelId,
        triggerMessageId: trigger.id,
        adapterKind: "hermes",
        status: "running",
        requestJson: {},
        startedAt: new Date(),
      })
      .returning({ id: botInvocations.id });

    const blocked = await req("POST", `/conversations/channel/${channelId}/archive`, undefined, owner.token);
    expect(blocked.status).toBe(409);
    expect((await ok("GET", `/conversations/detail/${channelId}`, undefined, owner.token)).archivedAt).toBeNull();

    await db.delete(queueJobs).where(eq(queueJobs.partitionKey, channelId));
    // Waiting to start, or claimed by the gateway without an answer yet, count too.
    for (const state of [
      { status: "queued" as const, adapterKind: "webhook" as const, responseJson: null },
      { status: "claimed" as const, adapterKind: "hermes" as const, responseJson: {} },
    ]) {
      await db.update(botInvocations).set(state).where(eq(botInvocations.id, invocation.id));
      const waiting = await req("POST", `/conversations/channel/${channelId}/archive`, undefined, owner.token);
      expect(waiting.status, state.status).toBe(409);
    }

    // A Hermes dispatch that timed out long ago does not hold the channel
    // hostage: it is closed with the archive instead of failing into it later.
    await db
      .update(botInvocations)
      .set({ status: "queued", adapterKind: "hermes", responseJson: null, createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000) })
      .where(eq(botInvocations.id, invocation.id));
    await ok("POST", `/conversations/channel/${channelId}/archive`, undefined, owner.token);
    const [stale] = await db.select().from(botInvocations).where(eq(botInvocations.id, invocation.id));
    expect(stale.status).toBe("cancelled");
    expect((await ok("GET", `/messages/${channelId}`, undefined, owner.token)).map((m: any) => m.id)).toEqual([trigger.id]);
  });
});
