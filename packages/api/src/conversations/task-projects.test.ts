import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { Elysia } from "elysia";
import { authRoutes } from "../auth";
import { botRoutes } from "../bots";
import { conversationRoutes } from "../conversations";
import { db } from "../db";
import {
  attachments,
  botInvocations,
  botRequests,
  conversationThreads,
  eventOutbox,
  messageAttachments,
  messages,
  users,
  workspaceMembers,
  workspaces,
} from "../db/schema";
import { hermesPlatformRoutes } from "../hermes-platform";
import { inviteRoutes } from "../invites";
import { messageRoutes } from "../messages";
import { workspaceRoutes } from "../workspaces";
import { deleteAttachmentObjects } from "../attachments/handler";
import { ATTACHMENT_DELETION_REQUESTED } from "../attachments/events";
import type { ObjectStore } from "../attachments/object-store";
import {
  closeRealtimeBusForTests,
  LocalRealtimeBus,
  setRealtimeBusForTests,
  type RealtimeEvent,
} from "../realtime";

const app = new Elysia()
  .use(authRoutes)
  .use(workspaceRoutes)
  .use(inviteRoutes)
  .use(conversationRoutes)
  .use(messageRoutes)
  .use(botRoutes)
  .use(hermesPlatformRoutes);

const createdUserEmails: string[] = [];
const createdWorkspaceIds: string[] = [];
const createdBotUserIds: string[] = [];
const realtimeEvents: RealtimeEvent[] = [];
let unsubscribeRealtime: (() => Promise<void>) | null = null;

beforeAll(async () => {
  const bus = new LocalRealtimeBus();
  await setRealtimeBusForTests(bus);
  unsubscribeRealtime = await bus.subscribe((event) => {
    realtimeEvents.push(event);
  });
});

beforeEach(() => {
  realtimeEvents.length = 0;
});

afterAll(async () => {
  const humans =
    createdUserEmails.length > 0
      ? await db
          .select({ id: users.id })
          .from(users)
          .where(inArray(users.email, createdUserEmails))
      : [];
  const actorIds = [...createdBotUserIds, ...humans.map((user) => user.id)];
  if (createdWorkspaceIds.length > 0) {
    await db
      .delete(eventOutbox)
      .where(inArray(eventOutbox.tenantId, createdWorkspaceIds));
  }
  if (actorIds.length > 0) {
    await db.delete(eventOutbox).where(inArray(eventOutbox.actorId, actorIds));
  }
  for (const workspaceId of createdWorkspaceIds) {
    await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
  }
  for (const userId of [...createdBotUserIds, ...humans.map((user) => user.id)]) {
    await db.delete(users).where(eq(users.id, userId));
  }
  await unsubscribeRealtime?.();
  await closeRealtimeBusForTests();
});

async function req(method: string, path: string, body?: unknown, token?: string) {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await app.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  const text = await response.text();
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed };
}

async function registerUser(name: string) {
  const email = `projects-${crypto.randomUUID()}@test.com`;
  createdUserEmails.push(email);
  const response = await req("POST", "/auth/register", {
    name,
    email,
    password: "password123",
  });
  expect(response.status).toBe(200);
  return {
    token: response.body.accessToken as string,
    user: response.body.user as { id: string; email: string },
  };
}

/** A workspace with a Hermes bot and the owner's DM with it. */
async function hermesFixture(label: string) {
  const owner = await registerUser(`${label} Owner`);
  const workspace = await req(
    "POST",
    "/workspaces/create",
    { name: `${label} ${crypto.randomUUID()}` },
    owner.token,
  );
  expect(workspace.status).toBe(200);
  const workspaceId = workspace.body.id as string;
  createdWorkspaceIds.push(workspaceId);
  const detail = await req("GET", `/workspaces/${workspaceId}`, undefined, owner.token);
  const generalChannelId = detail.body.channels[0].id as string;

  const bot = await req(
    "POST",
    "/bots/create",
    { name: `${label} Hermes`, kind: "hermes", workspaceId },
    owner.token,
  );
  expect(bot.status).toBe(200);
  createdBotUserIds.push(bot.body.userId);
  const dm = await req(
    "POST",
    "/conversations/dm",
    { workspaceId, otherUserId: bot.body.userId },
    owner.token,
  );
  expect(dm.status).toBe(200);
  return {
    owner,
    workspaceId,
    generalChannelId,
    bot: {
      id: bot.body.id as string,
      userId: bot.body.userId as string,
      apiKey: bot.body.apiKey as string,
    },
    dmId: dm.body.id as string,
  };
}

async function createTask(
  conversationId: string,
  token: string,
  body: Record<string, unknown>,
) {
  const created = await req("POST", `/conversations/threads/${conversationId}`, body, token);
  expect(created.status).toBe(200);
  return created.body as { id: string; projectId: string | null; title: string };
}

async function createProject(conversationId: string, token: string, name: string) {
  const created = await req("POST", `/conversations/projects/${conversationId}`, { name }, token);
  expect(created.status).toBe(200);
  return created.body as { id: string; name: string };
}

async function postMessage(
  conversationId: string,
  token: string,
  content: string,
  threadId?: string,
) {
  const sent = await req(
    "POST",
    `/messages/${conversationId}`,
    { content, ...(threadId ? { threadId } : {}) },
    token,
  );
  expect(sent.status).toBe(200);
  return sent.body.id as string;
}

/** Marks pending message events processed, as the outbox worker would. */
async function settleMessageEvents(conversationId: string) {
  await db
    .update(eventOutbox)
    .set({ publishedAt: new Date() })
    .where(eq(eventOutbox.partitionKey, conversationId));
}

function wsEvents(type: string) {
  return realtimeEvents
    .filter((event) => event.type === "ws.event" && event.event.type === type)
    .map((event) => (event.type === "ws.event" ? event : null)!);
}

describe("Task projects", () => {
  test("people create, rename and delete projects and move tasks between them", async () => {
    const fixture = await hermesFixture("Organize");
    const { owner, dmId } = fixture;
    const outsider = await registerUser("Organize Outsider");

    const research = await createProject(dmId, owner.token, "  Market   research ");
    expect(research.name).toBe("Market research");
    expect(wsEvents("task_project_updated")[0]).toMatchObject({
      targetUserIds: expect.arrayContaining([owner.user.id]),
      event: { conversationId: dmId, project: { id: research.id } },
    });

    expect(
      await req("POST", `/conversations/projects/${dmId}`, { name: "market RESEARCH" }, owner.token),
    ).toMatchObject({
      status: 409,
      body: { error: "A project with this name already exists" },
    });
    expect(
      (await req("POST", `/conversations/projects/${dmId}`, { name: "Spy" }, outsider.token))
        .status,
    ).toBe(403);
    expect(
      (await req("GET", `/conversations/projects/${dmId}`, undefined, outsider.token)).status,
    ).toBe(403);

    const launch = await createProject(dmId, owner.token, "Launch");
    const filed = await createTask(dmId, owner.token, {
      title: "Competitor pricing",
      projectId: research.id,
    });
    expect(filed.projectId).toBe(research.id);
    const loose = await createTask(dmId, owner.token, { title: "Inbox zero" });
    expect(loose.projectId).toBeNull();

    // A branch stays next to the task it came from.
    const branch = await createTask(dmId, owner.token, {
      title: "Pricing follow-up",
      branchFromThreadId: filed.id,
    });
    expect(branch.projectId).toBe(research.id);

    realtimeEvents.length = 0;
    const moved = await req(
      "PATCH",
      `/conversations/threads/${dmId}`,
      { threadId: loose.id, projectId: launch.id },
      owner.token,
    );
    expect(moved).toMatchObject({ status: 200, body: { id: loose.id, projectId: launch.id } });
    expect(wsEvents("conversation_thread_updated")[0]).toMatchObject({
      event: { thread: { id: loose.id, projectId: launch.id } },
    });

    // Renaming keeps the project; moving to null unfiles.
    const renamedTask = await req(
      "PATCH",
      `/conversations/threads/${dmId}`,
      { threadId: loose.id, title: "Inbox zero (weekly)" },
      owner.token,
    );
    expect(renamedTask.body).toMatchObject({ title: "Inbox zero (weekly)", projectId: launch.id });

    const listed = await req("GET", `/conversations/threads/${dmId}`, undefined, owner.token);
    expect(
      Object.fromEntries(
        (listed.body.items as Array<{ id: string; projectId: string | null }>).map((item) => [
          item.id,
          item.projectId,
        ]),
      ),
    ).toEqual({
      [filed.id]: research.id,
      [branch.id]: research.id,
      [loose.id]: launch.id,
    });

    const renamed = await req(
      "PATCH",
      `/conversations/projects/${dmId}/${launch.id}`,
      { name: "Launch v2" },
      owner.token,
    );
    expect(renamed).toMatchObject({ status: 200, body: { id: launch.id, name: "Launch v2" } });
    expect(
      (await req("GET", `/conversations/projects/${dmId}`, undefined, owner.token)).body.map(
        (project: { name: string }) => project.name,
      ),
    ).toEqual(["Market research", "Launch v2"]);

    realtimeEvents.length = 0;
    const deleted = await req(
      "DELETE",
      `/conversations/projects/${dmId}/${research.id}`,
      undefined,
      owner.token,
    );
    expect(deleted).toMatchObject({ status: 200, body: { deletedProjectId: research.id } });
    expect(wsEvents("task_project_deleted")[0]).toMatchObject({
      event: { conversationId: dmId, projectId: research.id },
    });
    // Deleting a project never deletes its tasks.
    const survivors = await db
      .select({ id: conversationThreads.id, projectId: conversationThreads.projectId })
      .from(conversationThreads)
      .where(inArray(conversationThreads.id, [filed.id, branch.id]));
    expect(survivors).toHaveLength(2);
    expect(survivors.every((thread) => thread.projectId === null)).toBe(true);
    expect(
      (
        await req(
          "PATCH",
          `/conversations/threads/${dmId}`,
          { threadId: filed.id, projectId: research.id },
          owner.token,
        )
      ).status,
    ).toBe(404);
  });

  test("tasks can only join projects from their own conversation", async () => {
    const fixture = await hermesFixture("Isolation");
    const { owner, dmId, generalChannelId } = fixture;
    const channelProject = await createProject(generalChannelId, owner.token, "Channel work");
    const task = await createTask(dmId, owner.token, { title: "DM task" });

    expect(
      await req(
        "PATCH",
        `/conversations/threads/${dmId}`,
        { threadId: task.id, projectId: channelProject.id },
        owner.token,
      ),
    ).toMatchObject({ status: 404, body: { error: "Project not found" } });
    expect(
      (
        await req(
          "POST",
          `/conversations/threads/${dmId}`,
          { title: "Smuggled", projectId: channelProject.id },
          owner.token,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await req(
          "GET",
          `/conversations/projects/${dmId}/${channelProject.id}`,
          undefined,
          owner.token,
        )
      ).status,
    ).toBe(404);
  });

  test("bots can read a project's tasks but cannot organize or delete tasks", async () => {
    const fixture = await hermesFixture("Bot Access");
    const { owner, dmId, bot } = fixture;
    const project = await createProject(dmId, owner.token, "Research");
    const first = await createTask(dmId, owner.token, { title: "First", projectId: project.id });
    const second = await createTask(dmId, owner.token, { title: "Second", projectId: project.id });
    await createTask(dmId, owner.token, { title: "Elsewhere" });

    const detail = await req(
      "GET",
      `/conversations/projects/${dmId}/${project.id}`,
      undefined,
      bot.apiKey,
    );
    expect(detail.status).toBe(200);
    expect(detail.body.project).toMatchObject({ id: project.id, name: "Research" });
    expect(detail.body.tasks.map((task: { id: string }) => task.id).sort()).toEqual(
      [first.id, second.id].sort(),
    );

    expect(
      (await req("POST", `/conversations/projects/${dmId}`, { name: "Bot made" }, bot.apiKey))
        .status,
    ).toBe(403);
    expect(
      (
        await req(
          "PATCH",
          `/conversations/threads/${dmId}`,
          { threadId: first.id, projectId: null },
          bot.apiKey,
        )
      ).status,
    ).toBe(403);
    expect(
      (await req("DELETE", `/conversations/threads/${dmId}/${first.id}`, undefined, bot.apiKey))
        .status,
    ).toBe(403);
    // Bots keep their existing ability to retitle tasks.
    expect(
      (
        await req(
          "PATCH",
          `/conversations/threads/${dmId}`,
          { threadId: first.id, title: "First (bot title)" },
          bot.apiKey,
        )
      ).body,
    ).toMatchObject({ title: "First (bot title)", projectId: project.id });
  });

  test("Hermes platform events describe the task's project and its sibling tasks", async () => {
    const fixture = await hermesFixture("Hermes Hint");
    const { owner, dmId, bot } = fixture;
    const project = await createProject(dmId, owner.token, "Q4 planning");
    const current = await createTask(dmId, owner.token, {
      title: "Budget draft",
      projectId: project.id,
    });
    const sibling = await createTask(dmId, owner.token, {
      title: "Hiring plan",
      projectId: project.id,
    });
    const unfiled = await createTask(dmId, owner.token, { title: "Unfiled chores" });

    const inProject = await postMessage(dmId, owner.token, "Draft the budget", current.id);
    const outsideProject = await postMessage(dmId, owner.token, "Do the chores", unfiled.id);
    await settleMessageEvents(dmId);
    for (const [messageId, threadId] of [
      [inProject, current.id],
      [outsideProject, unfiled.id],
    ] as const) {
      await db.insert(botInvocations).values({
        botId: bot.id,
        conversationId: dmId,
        threadId,
        triggerMessageId: messageId,
        adapterKind: "hermes",
        status: "queued",
        requestJson: { platform: "thechat" },
        responseJson: { status: "dispatch_pending" },
      });
    }

    const claimed = await req("GET", "/hermes-platform/events?limit=10", undefined, bot.apiKey);
    expect(claimed.status).toBe(200);
    const byThread = new Map(
      (claimed.body.events as Array<{ threadId: string }>).map((event) => [event.threadId, event]),
    );
    expect(byThread.get(current.id)).toMatchObject({
      project: {
        id: project.id,
        name: "Q4 planning",
        task: { id: current.id, title: "Budget draft" },
        otherTasks: [{ id: sibling.id, title: "Hiring plan" }],
        otherTasksTruncated: false,
      },
    });
    expect(byThread.get(unfiled.id)).toBeDefined();
    expect(byThread.get(unfiled.id)).not.toHaveProperty("project");

    // The hint tells Hermes to fetch sibling transcripts; that read works with its key.
    await postMessage(dmId, owner.token, "Two hires in Q4", sibling.id);
    const siblingMessages = await req(
      "GET",
      `/messages/${dmId}?threadId=${sibling.id}`,
      undefined,
      bot.apiKey,
    );
    expect(siblingMessages.status).toBe(200);
    expect(JSON.stringify(siblingMessages.body)).toContain("Two hires in Q4");
  });
});

describe("Task groups", () => {
  test("a quiet project's tasks are listed even when newer tasks fill a page", async () => {
    const { owner, dmId } = await hermesFixture("Groups");
    const outsider = await registerUser("Groups Outsider");
    const security = await createProject(dmId, owner.token, "Security");
    const empty = await createProject(dmId, owner.token, "Empty");
    const filed: string[] = [];
    for (const title of ["Rotate keys", "Audit logins", "Review firewall"]) {
      filed.unshift((await createTask(dmId, owner.token, { title, projectId: security.id })).id);
    }
    // Newer activity elsewhere: more than one page of unfiled tasks.
    const unfiled: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      unfiled.unshift((await createTask(dmId, owner.token, { title: `Chore ${index}` })).id);
    }

    // The old shape: one recency-ordered page shows no Security task at all.
    const recent = await req("GET", `/conversations/threads/${dmId}?limit=2`, undefined, owner.token);
    expect(recent.body.items.map((item: { id: string }) => item.id)).toEqual(unfiled.slice(0, 2));
    expect(recent.body.totalCount).toBe(8);

    const grouped = await req("GET", `/conversations/thread-groups/${dmId}?limit=2`, undefined, owner.token);
    expect(grouped.status).toBe(200);
    const byProject = new Map(
      (grouped.body.groups as Array<{ projectId: string | null; nextCursor: string | null }>).map(
        (group) => [group.projectId, group],
      ),
    );
    expect(byProject.get(security.id)).toMatchObject({
      items: [{ id: filed[0] }, { id: filed[1] }],
      hasMore: true,
      totalCount: 3,
    });
    expect(byProject.get(empty.id)).toMatchObject({
      items: [],
      hasMore: false,
      nextCursor: null,
      totalCount: 0,
    });
    expect(byProject.get(null)).toMatchObject({
      items: [{ id: unfiled[0] }, { id: unfiled[1] }],
      hasMore: true,
      totalCount: 5,
    });

    // Each group pages on its own from its cursor, never mixing groups.
    const securityCursor = byProject.get(security.id)?.nextCursor;
    expect(securityCursor).toBeTruthy();
    const next = await req(
      "GET",
      `/conversations/threads/${dmId}?limit=2&projectId=${security.id}&cursor=${securityCursor}`,
      undefined,
      owner.token,
    );
    expect(next.body).toMatchObject({
      items: [{ id: filed[2], projectId: security.id }],
      hasMore: false,
      totalCount: 3,
    });
    const unfiledPage = await req(
      "GET",
      `/conversations/threads/${dmId}?limit=10&projectId=none`,
      undefined,
      owner.token,
    );
    expect(unfiledPage.body.items.map((item: { id: string }) => item.id)).toEqual(unfiled);
    expect(
      (await req("GET", `/conversations/threads/${dmId}?projectId=nope`, undefined, owner.token)).status,
    ).toBe(400);

    // A task off every loaded page can still be opened by id.
    expect(
      await req("GET", `/conversations/threads/${dmId}/${filed[2]}`, undefined, owner.token),
    ).toMatchObject({ status: 200, body: { id: filed[2], projectId: security.id } });
    expect(
      (await req("GET", `/conversations/threads/${dmId}/${crypto.randomUUID()}`, undefined, owner.token))
        .status,
    ).toBe(404);

    for (const path of [
      `/conversations/thread-groups/${dmId}`,
      `/conversations/threads/${dmId}/${filed[0]}`,
    ]) {
      expect((await req("GET", path, undefined, outsider.token)).status).toBe(403);
    }
  });
});

describe("Task deletion", () => {
  test("removes the task's messages, runs, requests and files and nothing else", async () => {
    const fixture = await hermesFixture("Delete");
    const { owner, dmId, bot } = fixture;
    const doomed = await createTask(dmId, owner.token, { title: "Throwaway" });
    const kept = await createTask(dmId, owner.token, { title: "Keeper" });
    const doomedMessage = await postMessage(dmId, owner.token, "Doomed text", doomed.id);
    const keptMessage = await postMessage(dmId, owner.token, "Kept text", kept.id);
    const looseMessage = await postMessage(dmId, owner.token, "Unthreaded text");

    // A finished run inside the task, plus a request it raised.
    const [run] = await db
      .insert(botInvocations)
      .values({
        botId: bot.id,
        conversationId: dmId,
        threadId: doomed.id,
        triggerMessageId: doomedMessage,
        adapterKind: "hermes",
        status: "completed",
        completedAt: new Date(),
      })
      .returning({ id: botInvocations.id });
    await db.insert(botRequests).values({
      botId: bot.id,
      conversationId: dmId,
      threadId: doomed.id,
      invocationId: run!.id,
      clientKey: `delete-${crypto.randomUUID()}`,
      kind: "question",
      title: "Which colour?",
      responseSpec: { type: "text" },
    });

    const now = Date.now();
    const [file] = await db
      .insert(attachments)
      .values({
        conversationId: dmId,
        uploaderId: owner.user.id,
        fileName: "notes.txt",
        declaredMediaType: "text/plain",
        declaredSizeBytes: 5,
        declaredChecksumSha256: "0".repeat(64),
        status: "attached",
        quarantineKey: `quarantine/${crypto.randomUUID()}`,
        quarantineVersionId: "q-1",
        cleanKey: `clean/${crypto.randomUUID()}`,
        cleanVersionId: "c-1",
        uploadExpiresAt: new Date(now + 60_000),
        expiresAt: new Date(now + 120_000),
        attachedAt: new Date(),
      })
      .returning();
    await db
      .insert(messageAttachments)
      .values({ messageId: doomedMessage, attachmentId: file!.id, position: 0 });

    // A bot-targeted message that has not been dispatched yet blocks deletion.
    const blocked = await req(
      "DELETE",
      `/conversations/threads/${dmId}/${doomed.id}`,
      undefined,
      owner.token,
    );
    expect(blocked.status).toBe(409);
    await settleMessageEvents(dmId);

    realtimeEvents.length = 0;
    const deleted = await req(
      "DELETE",
      `/conversations/threads/${dmId}/${doomed.id}`,
      undefined,
      owner.token,
    );
    expect(deleted).toMatchObject({
      status: 200,
      body: {
        ok: true,
        deletedThreadId: doomed.id,
        deletedMessageCount: 1,
        deletedRequestCount: 1,
        deletedAttachmentCount: 1,
      },
    });
    expect(wsEvents("conversation_thread_deleted")[0]).toMatchObject({
      targetUserIds: expect.arrayContaining([owner.user.id]),
      event: { conversationId: dmId, threadId: doomed.id },
    });

    expect(
      await db.select().from(conversationThreads).where(eq(conversationThreads.id, doomed.id)),
    ).toHaveLength(0);
    expect(
      (
        await db
          .select({ id: messages.id })
          .from(messages)
          .where(inArray(messages.id, [doomedMessage, keptMessage, looseMessage]))
      )
        .map((row) => row.id)
        .sort(),
    ).toEqual([keptMessage, looseMessage].sort());
    expect(await db.select().from(botInvocations).where(eq(botInvocations.id, run!.id))).toHaveLength(0);
    expect(
      await db.select().from(botRequests).where(eq(botRequests.conversationId, dmId)),
    ).toHaveLength(0);
    expect(
      (await req("GET", `/conversations/threads/${dmId}`, undefined, owner.token)).body.items.map(
        (item: { id: string }) => item.id,
      ),
    ).toEqual([kept.id]);

    // The file row survives as `deleting` with an outbox job that frees storage.
    const [pendingFile] = await db.select().from(attachments).where(eq(attachments.id, file!.id));
    expect(pendingFile!.status).toBe("deleting");
    const [deletionJob] = await db
      .select({ id: eventOutbox.id })
      .from(eventOutbox)
      .where(
        and(
          eq(eventOutbox.eventType, ATTACHMENT_DELETION_REQUESTED),
          eq(eventOutbox.aggregateId, file!.id),
        ),
      );
    expect(deletionJob).toBeDefined();

    const deleteCalls: Array<{ key: string; versionId?: string | null }> = [];
    const store = {
      deleteObject: async (input: { key: string; versionId?: string | null }) => {
        deleteCalls.push(input);
      },
    } as unknown as ObjectStore;
    await deleteAttachmentObjects(file!.id, store);
    expect(deleteCalls).toEqual([
      { key: file!.cleanKey!, versionId: "c-1" },
      { key: file!.quarantineKey, versionId: "q-1" },
    ]);
    const [cleaned] = await db.select().from(attachments).where(eq(attachments.id, file!.id));
    expect(cleaned!.status).toBe("deleted");

    expect(
      (await req("DELETE", `/conversations/threads/${dmId}/${doomed.id}`, undefined, owner.token))
        .status,
    ).toBe(404);
  });

  test("waits for an active bot run to finish", async () => {
    const fixture = await hermesFixture("Delete Busy");
    const { owner, dmId, bot } = fixture;
    const task = await createTask(dmId, owner.token, { title: "Busy" });
    const trigger = await postMessage(dmId, owner.token, "Go", task.id);
    await settleMessageEvents(dmId);
    const [run] = await db
      .insert(botInvocations)
      .values({
        botId: bot.id,
        conversationId: dmId,
        threadId: task.id,
        triggerMessageId: trigger,
        adapterKind: "hermes",
        status: "running",
        startedAt: new Date(),
      })
      .returning({ id: botInvocations.id });

    expect(
      await req("DELETE", `/conversations/threads/${dmId}/${task.id}`, undefined, owner.token),
    ).toMatchObject({
      status: 409,
      body: { error: "Wait for the bot to finish working on this task before deleting it" },
    });
    expect(
      await db.select().from(conversationThreads).where(eq(conversationThreads.id, task.id)),
    ).toHaveLength(1);

    await db
      .update(botInvocations)
      .set({ status: "completed", completedAt: new Date() })
      .where(eq(botInvocations.id, run!.id));
    expect(
      (await req("DELETE", `/conversations/threads/${dmId}/${task.id}`, undefined, owner.token))
        .status,
    ).toBe(200);
  });

  test("in channels only the task's creator or a workspace admin can delete it", async () => {
    const fixture = await hermesFixture("Delete Channel");
    const { owner, workspaceId, generalChannelId } = fixture;
    const member = await registerUser("Delete Channel Member");
    const other = await registerUser("Delete Channel Other");
    for (const person of [member, other]) {
      const invite = await req(
        "POST",
        "/invites/create",
        { workspaceId, email: person.user.email },
        owner.token,
      );
      expect(invite.status).toBe(200);
      expect(
        (await req("POST", "/invites/accept", { inviteId: invite.body.id }, person.token)).status,
      ).toBe(200);
    }

    const memberTask = await createTask(generalChannelId, member.token, { title: "Mine" });
    const ownerTask = await createTask(generalChannelId, owner.token, { title: "Owner's" });

    expect(
      (
        await req(
          "DELETE",
          `/conversations/threads/${generalChannelId}/${memberTask.id}`,
          undefined,
          other.token,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await req(
          "DELETE",
          `/conversations/threads/${generalChannelId}/${memberTask.id}`,
          undefined,
          member.token,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await req(
          "DELETE",
          `/conversations/threads/${generalChannelId}/${ownerTask.id}`,
          undefined,
          member.token,
        )
      ).status,
    ).toBe(403);

    await db
      .update(workspaceMembers)
      .set({ role: "admin" })
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.userId, other.user.id),
        ),
      );
    expect(
      (
        await req(
          "DELETE",
          `/conversations/threads/${generalChannelId}/${ownerTask.id}`,
          undefined,
          other.token,
        )
      ).status,
    ).toBe(200);
  });
});
