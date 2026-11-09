import { afterAll, beforeAll, expect, test } from "bun:test";
import crypto from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { Elysia } from "elysia";
import { authRoutes } from "../auth";
import { botRoutes } from "../bots";
import { conversationRoutes } from "../conversations";
import { workspaceRoutes } from "../workspaces";
import { inviteRoutes } from "../invites";
import { messageRoutes } from "./index";
import { db } from "../db";
import { queueJobs } from "../async/job-schema";
import { users, workspaces, workspaceMembers, conversationParticipants, conversationThreads, botInvocations, messages, messageUnreads, messageReactions } from "../db/schema";
import { closeRealtimeBusForTests, LocalRealtimeBus, setRealtimeBusForTests, type RealtimeEvent } from "../realtime";
import { listActivity } from "../services/activity";
import { searchMessages, getMessageContext } from "../services/search";

const app = new Elysia().use(authRoutes).use(workspaceRoutes).use(inviteRoutes).use(conversationRoutes).use(messageRoutes).use(botRoutes);
const userIds: string[] = [], workspaceIds: string[] = [];
const events: RealtimeEvent[] = [];
let unsubscribe: (() => Promise<void>) | undefined;
beforeAll(async () => {
  const bus = new LocalRealtimeBus();
  await setRealtimeBusForTests(bus);
  unsubscribe = await bus.subscribe((event) => { events.push(event); });
});
afterAll(async () => {
  if (userIds.length) await db.delete(queueJobs).where(inArray(queueJobs.actorId, userIds));
  if (workspaceIds.length) await db.delete(workspaces).where(inArray(workspaces.id, workspaceIds));
  if (userIds.length) await db.delete(users).where(inArray(users.id, userIds));
  await unsubscribe?.();
  await closeRealtimeBusForTests();
});
async function req(method: string, path: string, token?: string, body?: unknown) {
  const response = await app.handle(new Request(`http://localhost${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }));
  const text = await response.text();
  let data: any; try { data = JSON.parse(text); } catch { data = text; }
  return { status: response.status, data };
}
async function register(name: string) {
  const r = await req("POST", "/auth/register", undefined, { name, email: `delete-${crypto.randomUUID()}@example.invalid`, password: "Synthetic-password-123!" });
  expect(r.status).toBe(200); userIds.push(r.data.user.id);
  return { token: r.data.accessToken as string, id: r.data.user.id as string, email: r.data.user.email as string };
}
async function fixture() {
  const owner = await register("Workspace owner"), author = await register("Message author");
  const r = await req("POST", "/workspaces/create", owner.token, { name: "Deletion test" });
  expect(r.status).toBe(200); workspaceIds.push(r.data.id);
  const workspaceId = r.data.id as string;
  const invite = await req("POST", "/invites/create", owner.token, { workspaceId, email: author.email });
  expect(invite.status).toBe(200);
  expect((await req("POST", "/invites/accept", author.token, { inviteId: invite.data.id })).status).toBe(200);
  const detail = await req("GET", `/workspaces/${workspaceId}`, owner.token);
  return { owner, author, workspaceId, channelId: detail.data.channels[0].id as string };
}
async function send(conversationId: string, token: string, content = "Accidental sent message", threadId?: string) {
  const r = await req("POST", `/messages/${conversationId}`, token, { content, ...(threadId ? { threadId } : {}) });
  expect(r.status).toBe(200); return r.data;
}

test("only the author may delete: not unauthenticated, outsider, participant or workspace owner", async () => {
  const f = await fixture(); const outsider = await register("Outsider");
  const message = await send(f.channelId, f.author.token);
  const path = `/messages/${f.channelId}/${message.id}`;
  for (const [token, status] of [[undefined, 401], [outsider.token, 403], [f.owner.token, 403]] as const) {
    expect((await req("DELETE", path, token)).status).toBe(status);
    expect(await db.select().from(messages).where(eq(messages.id, message.id))).toHaveLength(1);
  }
  events.length = 0;
  expect((await req("DELETE", path, f.author.token)).status).toBe(200);
  const deletion = events.find((event) => event.type === "ws.event" && event.event.type === "message_deleted");
  expect(deletion).toBeDefined();
  if (!deletion || deletion.type !== "ws.event") throw new Error("Missing deletion event");
  expect(deletion.targetUserIds.toSorted()).toEqual([f.owner.id, f.author.id].toSorted());
  expect(deletion!.event).toEqual({ type: "message_deleted", conversationId: f.channelId, messageId: message.id, threadId: null });
  expect((await req("GET", `/messages/${f.channelId}`, f.owner.token)).data).toEqual([]);
  expect((await req("DELETE", path, f.author.token)).status).toBe(404);
});

test("wrong conversation, nonexistent and malformed IDs cannot delete a message", async () => {
  const f = await fixture();
  const dm = await req("POST", "/conversations/dm", f.author.token, { workspaceId: f.workspaceId, otherUserId: f.owner.id });
  const message = await send(f.channelId, f.author.token);
  expect((await req("DELETE", `/messages/${dm.data.id}/${message.id}`, f.author.token)).status).toBe(404);
  expect((await req("DELETE", `/messages/${f.channelId}/${crypto.randomUUID()}`, f.author.token)).status).toBe(404);
  expect((await req("DELETE", `/messages/${f.channelId}/bad-id`, f.author.token)).status).toBe(400);
  expect((await req("DELETE", `/messages/bad-id/${message.id}`, f.author.token)).status).toBe(400);
  expect(await db.select().from(messages).where(eq(messages.id, message.id))).toHaveLength(1);
});

for (const lostAccess of ["membership", "participation"] as const) {
  test(`authorship does not bypass lost ${lostAccess}`, async () => {
    const f = await fixture(); const message = await send(f.channelId, f.author.token);
    if (lostAccess === "membership") {
      await db.delete(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, f.workspaceId), eq(workspaceMembers.userId, f.author.id)));
    } else {
      await db.delete(conversationParticipants).where(and(eq(conversationParticipants.conversationId, f.channelId), eq(conversationParticipants.userId, f.author.id)));
    }
    expect((await req("DELETE", `/messages/${f.channelId}/${message.id}`, f.author.token)).status).toBe(403);
    expect(await db.select().from(messages).where(eq(messages.id, message.id))).toHaveLength(1);
  });
}

test("hard delete removes reactions, search, context and unread Activity but keeps other messages", async () => {
  const f = await fixture();
  const keep = await send(f.channelId, f.author.token, "Keep this message");
  const message = await send(f.channelId, f.author.token, "Unique accidental message");
  expect((await req("POST", `/messages/${f.channelId}/${message.id}/reactions`, f.owner.token, { emoji: "👍", active: true })).status).toBe(200);
  const search = () => searchMessages(f.owner.id, { query: "Unique accidental", conversationId: f.channelId });
  expect((await search()).results.map((hit) => hit.id)).toEqual([message.id]);
  expect((await listActivity(f.owner.id)).totalUnreadMessages).toBe(2);
  expect((await req("DELETE", `/messages/${f.channelId}/${message.id}`, f.author.token)).status).toBe(200);
  expect(await db.select().from(messageReactions).where(eq(messageReactions.messageId, message.id))).toEqual([]);
  expect(await db.select().from(messageUnreads).where(eq(messageUnreads.messageId, message.id))).toEqual([]);
  expect((await search()).results).toEqual([]);
  await expect(getMessageContext(f.owner.id, message.id, {})).rejects.toMatchObject({ status: 404 });
  const activity = await listActivity(f.owner.id);
  expect(activity.totalUnreadMessages).toBe(1);
  expect(activity.items[0].latestMessage.id).toBe(keep.id);
});

test("authors can delete in DMs and task scopes without deleting siblings or the task", async () => {
  const f = await fixture();
  const dm = await req("POST", "/conversations/dm", f.author.token, { workspaceId: f.workspaceId, otherUserId: f.owner.id });
  expect(dm.status).toBe(200);
  const direct = await send(dm.data.id, f.author.token);
  expect((await req("DELETE", `/messages/${dm.data.id}/${direct.id}`, f.author.token)).status).toBe(200);
  const bot = await req("POST", "/bots/create", f.owner.token, { name: "Task bot", kind: "hermes", workspaceId: f.workspaceId });
  expect(bot.status).toBe(200); userIds.push(bot.data.userId);
  const botDm = await req("POST", "/conversations/dm", f.author.token, { workspaceId: f.workspaceId, otherUserId: bot.data.userId });
  expect(botDm.status).toBe(200);
  const task = await req("POST", `/conversations/threads/${botDm.data.id}`, f.author.token, { title: "Task" });
  expect(task.status).toBe(200);
  const thread = task.data;
  // Seed a task message directly: real Hermes delivery must not run in this test.
  const [first, reply] = await db.insert(messages).values([
    { conversationId: botDm.data.id, senderId: f.author.id, threadId: thread.id, content: "First task message" },
    { conversationId: botDm.data.id, senderId: bot.data.userId, threadId: thread.id, content: "Keep reply" },
  ]).returning();
  expect((await req("DELETE", `/messages/${botDm.data.id}/${reply.id}`, f.author.token)).status).toBe(403);
  const [run] = await db.insert(botInvocations).values({ botId: bot.data.id, conversationId: botDm.data.id, triggerMessageId: first.id, adapterKind: "hermes", status: "running" }).returning();
  expect((await req("DELETE", `/messages/${botDm.data.id}/${first.id}`, f.author.token)).status).toBe(409);
  await db.update(botInvocations).set({ status: "completed" }).where(eq(botInvocations.id, run.id));
  expect((await req("DELETE", `/messages/${botDm.data.id}/${first.id}`, f.author.token)).status).toBe(200);
  expect(await db.select().from(conversationThreads).where(eq(conversationThreads.id, thread.id))).toHaveLength(1);
  expect(await db.select().from(messages).where(eq(messages.id, reply.id))).toHaveLength(1);
});
