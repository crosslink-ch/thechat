import { afterAll, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { Elysia } from "elysia";
import { activityRoutes } from "../activity";
import { authRoutes } from "../auth";
import { conversationRoutes } from "../conversations";
import { db } from "../db";
import { users, workspaces } from "../db/schema";
import { queueJobs as eventOutbox } from "../async/job-schema";
import { inviteRoutes } from "../invites";
import { workspaceRoutes } from "../workspaces";
import { searchRoutes } from "../search";
import { messageRoutes } from "./index";

const app = new Elysia()
  .use(authRoutes)
  .use(workspaceRoutes)
  .use(inviteRoutes)
  .use(conversationRoutes)
  .use(messageRoutes)
  .use(activityRoutes)
  .use(searchRoutes);

const createdEmails: string[] = [];
const createdWorkspaceIds: string[] = [];

afterAll(async () => {
  // No worker drains this file's domain events: remove them so later suites
  // sharing the database (push delivery) do not pick them up.
  const humans = createdEmails.length
    ? await db.select({ id: users.id }).from(users).where(inArray(users.email, createdEmails))
    : [];
  if (humans.length) {
    await db.delete(eventOutbox).where(inArray(eventOutbox.actorId, humans.map((user) => user.id)));
  }
  if (createdWorkspaceIds.length) {
    await db.delete(eventOutbox).where(inArray(eventOutbox.tenantId, createdWorkspaceIds));
  }
  for (const id of createdWorkspaceIds) await db.delete(workspaces).where(eq(workspaces.id, id));
  for (const email of createdEmails) await db.delete(users).where(eq(users.email, email));
});

async function req(method: string, path: string, body?: unknown, token?: string) {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await app.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  const text = await response.text();
  let parsed: any = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Keep text responses for assertion messages.
  }
  return { status: response.status, body: parsed };
}

async function ok(method: string, path: string, body?: unknown, token?: string) {
  const response = await req(method, path, body, token);
  expect(response.status, `${method} ${path}: ${JSON.stringify(response.body)}`).toBe(200);
  return response.body;
}

type Person = { token: string; id: string; name: string; email: string };

async function register(name: string): Promise<Person> {
  const email = `threads-${crypto.randomUUID()}@test.com`;
  createdEmails.push(email);
  const body = await ok("POST", "/auth/register", { name, email, password: "password123" });
  return { token: body.accessToken, id: body.user.id, name, email };
}

/** A workspace with owner Ana, Ben and Cleo, its #general and Ana↔Ben DM. */
async function fixture(label: string) {
  const ana = await register(`Ana ${label}`);
  const ben = await register(`Ben ${label}`);
  const cleo = await register(`Cleo ${label}`);
  const workspace = await ok("POST", "/workspaces/create", { name: `Threads ${label}` }, ana.token);
  createdWorkspaceIds.push(workspace.id);
  for (const member of [ben, cleo]) {
    const invite = await ok("POST", "/invites/create", { workspaceId: workspace.id, email: member.email }, ana.token);
    await ok("POST", "/invites/accept", { inviteId: invite.id }, member.token);
  }
  const detail = await ok("GET", `/workspaces/${workspace.id}`, undefined, ana.token);
  const channelId = detail.channels.find((channel: { name: string }) => channel.name === "general").id as string;
  const dm = await ok("POST", "/conversations/dm", { workspaceId: workspace.id, otherUserId: ben.id }, ana.token);
  return { ana, ben, cleo, workspaceId: workspace.id as string, channelId, dmId: dm.id as string };
}

function send(person: Person, conversationId: string, content: string, extra: Record<string, unknown> = {}) {
  return ok("POST", `/messages/${conversationId}`, { content, ...extra }, person.token);
}

function activity(person: Person) {
  return ok("GET", "/activity", undefined, person.token);
}

describe("Reply threads", () => {
  test("replies stay out of the timeline, flatten to the root and summarize on it", async () => {
    const { ana, ben, cleo, channelId } = await fixture("timeline");
    const root = await send(ana, channelId, "Shall we ship Friday?");
    const first = await send(ben, channelId, "Yes, after QA", { parentMessageId: root.id });
    expect(first.parentMessageId).toBe(root.id);
    // Replying to a reply continues the same thread.
    const second = await send(cleo, channelId, "Agreed", { parentMessageId: first.id });
    expect(second.parentMessageId).toBe(root.id);

    const timeline = await ok("GET", `/messages/${channelId}`, undefined, ana.token);
    expect(timeline.map((message: { id: string }) => message.id)).toEqual([root.id]);
    expect(timeline[0].thread.replyCount).toBe(2);
    expect(timeline[0].thread.participants.map((p: { name: string }) => p.name)).toEqual([cleo.name, ben.name]);

    const page = await ok("GET", `/messages/${channelId}/threads/${root.id}`, undefined, ben.token);
    expect(page.root.id).toBe(root.id);
    expect(page.replies.map((reply: { content: string }) => reply.content)).toEqual(["Yes, after QA", "Agreed"]);
    expect(page.following).toBe(true);
    expect(page.hasOlder).toBe(false);

    // Opening a reply as a root is refused; so is a parent from elsewhere.
    expect((await req("GET", `/messages/${channelId}/threads/${first.id}`, undefined, ana.token)).status).toBe(400);
    const other = await fixture("elsewhere");
    const foreign = await send(other.ana, other.channelId, "Foreign root");
    expect(
      (await req("POST", `/messages/${channelId}`, { content: "x", parentMessageId: foreign.id }, ana.token)).status,
    ).toBe(400);
  });

  test("also sending to the conversation puts the reply in the timeline", async () => {
    const { ana, ben, channelId } = await fixture("broadcast");
    const root = await send(ana, channelId, "Release notes draft");
    const reply = await send(ben, channelId, "Final version attached", {
      parentMessageId: root.id,
      alsoSendToConversation: true,
    });
    expect(reply.alsoSentToConversation).toBe(true);
    const timeline = await ok("GET", `/messages/${channelId}`, undefined, ana.token);
    expect(timeline.map((message: { id: string }) => message.id)).toEqual([root.id, reply.id]);
  });

  test("only followers get unread replies, grouped as threads in Activity", async () => {
    const { ana, ben, cleo, channelId } = await fixture("followers");
    const root = await send(ana, channelId, "Who owns the migration?");
    await ok("POST", "/activity/read-all", {}, ben.token);
    await ok("POST", "/activity/read-all", {}, cleo.token);

    await send(ben, channelId, "I can take it", { parentMessageId: root.id });
    // Ana started the thread: she follows it. Cleo does not, and her
    // channel does not become unread for a reply she never sees.
    const anaActivity = await activity(ana);
    expect(anaActivity.threads).toHaveLength(1);
    expect(anaActivity.threads[0].rootMessageId).toBe(root.id);
    expect(anaActivity.threads[0].root.content).toBe("Who owns the migration?");
    expect(anaActivity.threads[0].unreadCount).toBe(1);
    expect(anaActivity.items.some((item: { conversationId: string }) => item.conversationId === channelId)).toBe(false);
    const cleoActivity = await activity(cleo);
    expect(cleoActivity.threads).toHaveLength(0);
    expect(cleoActivity.totalUnreadMessages).toBe(0);

    // An @mention in a reply makes Cleo a follower.
    await send(ben, channelId, `@${cleo.name} can you review?`, { parentMessageId: root.id });
    const mentioned = await activity(cleo);
    expect(mentioned.threads.map((thread: { rootMessageId: string }) => thread.rootMessageId)).toEqual([root.id]);
    const page = await ok("GET", `/messages/${channelId}/threads/${root.id}`, undefined, cleo.token);
    expect(page.following).toBe(true);
    expect(page.unreadMessageIds).toHaveLength(1);
  });

  test("thread and timeline unread state are marked read separately", async () => {
    const { ana, ben, channelId } = await fixture("reads");
    const root = await send(ana, channelId, "Root");
    await send(ben, channelId, "Main timeline message");
    await send(ben, channelId, "Thread reply", { parentMessageId: root.id });
    let snapshot = await activity(ana);
    expect(snapshot.totalUnreadMessages).toBe(2);

    // Marking the channel read leaves the followed thread unread.
    snapshot = await ok("POST", `/activity/conversations/${channelId}/read`, { all: true }, ana.token);
    expect(snapshot.items).toHaveLength(0);
    expect(snapshot.threads).toHaveLength(1);

    snapshot = await ok(
      "POST",
      `/activity/conversations/${channelId}/read`,
      { all: true, rootMessageId: root.id },
      ana.token,
    );
    expect(snapshot.threads).toHaveLength(0);
    expect(snapshot.totalUnreadMessages).toBe(0);
  });

  test("in a DM both people follow; unfollowing clears and silences, replying refollows", async () => {
    const { ana, ben, dmId } = await fixture("dm");
    const root = await send(ana, dmId, "Lunch tomorrow?");
    await ok("POST", "/activity/read-all", {}, ben.token);
    await send(ana, dmId, "Or Thursday", { parentMessageId: root.id });
    const benActivity = await activity(ben);
    expect(benActivity.threads).toHaveLength(1);
    expect(benActivity.threads[0].conversationName).toBe(ana.name);
    expect(benActivity.items).toHaveLength(0);

    const unfollowed = await ok("POST", `/messages/${dmId}/threads/${root.id}/follow`, { following: false }, ben.token);
    expect(unfollowed.following).toBe(false);
    expect((await activity(ben)).threads).toHaveLength(0);
    await send(ana, dmId, "Let me know", { parentMessageId: root.id });
    expect((await activity(ben)).totalUnreadMessages).toBe(0);

    await send(ben, dmId, "Thursday works", { parentMessageId: root.id });
    const page = await ok("GET", `/messages/${dmId}/threads/${root.id}`, undefined, ben.token);
    expect(page.following).toBe(true);
  });

  test("lists followed threads with their newest replies", async () => {
    const { ana, ben, cleo, workspaceId, channelId, dmId } = await fixture("list");
    const older = await send(ana, channelId, "Older thread");
    const newer = await send(ana, dmId, "Newer thread");
    await send(ana, channelId, "Not a thread");
    for (const content of ["one", "two", "three", "four"]) {
      await send(ben, channelId, content, { parentMessageId: older.id });
    }
    await send(ben, dmId, "dm reply", { parentMessageId: newer.id });

    const page = await ok("GET", `/activity/threads?workspaceId=${workspaceId}`, undefined, ana.token);
    expect(page.items.map((item: { root: { id: string } }) => item.root.id)).toEqual([newer.id, older.id]);
    const channelThread = page.items[1];
    expect(channelThread.replyCount).toBe(4);
    expect(channelThread.unreadCount).toBe(4);
    expect(channelThread.latestReplies.map((reply: { content: string }) => reply.content)).toEqual([
      "two",
      "three",
      "four",
    ]);
    expect(page.items[0].conversationName).toBe(ben.name);
    expect(page.nextCursor).toBeNull();
    // Cleo follows nothing here.
    expect((await ok("GET", "/activity/threads", undefined, cleo.token)).items).toHaveLength(0);
  });

  test("an idempotency key cannot be reused for a different thread", async () => {
    const { ana, channelId } = await fixture("idempotency");
    const root = await send(ana, channelId, "Root");
    const clientMessageId = crypto.randomUUID();
    await send(ana, channelId, "Same text", { clientMessageId });
    const conflict = await req(
      "POST",
      `/messages/${channelId}`,
      { content: "Same text", clientMessageId, parentMessageId: root.id },
      ana.token,
    );
    expect(conflict.status).toBe(409);
  });

  test("search context of a reply is its thread", async () => {
    const { ana, ben, channelId } = await fixture("search");
    const marker = `marker${crypto.randomUUID().slice(0, 8)}`;
    const root = await send(ana, channelId, "Root question");
    await send(ben, channelId, "Unrelated timeline message");
    const reply = await send(ben, channelId, `Answer with ${marker}`, { parentMessageId: root.id });
    const results = await ok("GET", `/search/messages?q=${marker}`, undefined, ana.token);
    expect(results.results[0].parentMessageId).toBe(root.id);
    const context = await ok("GET", `/search/messages/${reply.id}/context`, undefined, ana.token);
    expect(context.replyRootId).toBe(root.id);
    expect(context.messages.map((message: { id: string }) => message.id)).toEqual([root.id, reply.id]);
  });
});
