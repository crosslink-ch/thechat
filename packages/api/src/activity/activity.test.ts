import { afterAll, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { Elysia } from "elysia";
import { activityRoutes } from "./index";
import { authRoutes } from "../auth";
import { botRoutes } from "../bots";
import { conversationRoutes } from "../conversations";
import { db } from "../db";
import { messages, users, workspaces } from "../db/schema";
import { recordMessageUnreads } from "../services/activity";
import { inviteRoutes } from "../invites";
import { messageRoutes } from "../messages";
import { workspaceRoutes } from "../workspaces";

const app = new Elysia()
  .use(authRoutes)
  .use(botRoutes)
  .use(workspaceRoutes)
  .use(inviteRoutes)
  .use(conversationRoutes)
  .use(messageRoutes)
  .use(activityRoutes);

const createdUserEmails: string[] = [];
const createdBotUserIds: string[] = [];
const createdWorkspaceIds: string[] = [];

async function req(
  method: string,
  path: string,
  body?: unknown,
  token?: string,
) {
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
    // Preserve framework text responses in failure assertions.
  }
  return { status: response.status, body: parsed };
}

async function registerUser(name: string) {
  const email = `activity-${crypto.randomUUID()}@test.com`;
  createdUserEmails.push(email);
  const response = await req("POST", "/auth/register", {
    name,
    email,
    password: "password123",
  });
  expect(response.status).toBe(200);
  return {
    token: response.body.accessToken as string,
    user: response.body.user as { id: string; email: string; name: string },
  };
}

async function createSharedWorkspace(
  owner: Awaited<ReturnType<typeof registerUser>>,
  member: Awaited<ReturnType<typeof registerUser>>,
  name: string,
) {
  const workspace = await req(
    "POST",
    "/workspaces/create",
    { name },
    owner.token,
  );
  expect(workspace.status).toBe(200);
  createdWorkspaceIds.push(workspace.body.id);

  const invite = await req(
    "POST",
    "/invites/create",
    { workspaceId: workspace.body.id, email: member.user.email },
    owner.token,
  );
  expect(invite.status).toBe(200);
  expect(
    (
      await req(
        "POST",
        "/invites/accept",
        { inviteId: invite.body.id },
        member.token,
      )
    ).status,
  ).toBe(200);

  const details = await req(
    "GET",
    `/workspaces/${workspace.body.id}`,
    undefined,
    owner.token,
  );
  expect(details.status).toBe(200);
  const channel = details.body.channels.find(
    (candidate: { name: string }) => candidate.name === "general",
  );
  expect(channel).toBeDefined();
  return {
    id: workspace.body.id as string,
    name: workspace.body.name as string,
    channelId: channel.id as string,
  };
}

async function sendMessage(token: string, conversationId: string, content: string, threadId?: string) {
  const response = await req(
    "POST",
    `/messages/${conversationId}`,
    { content, ...(threadId ? { threadId } : {}) },
    token,
  );
  expect(response.status).toBe(200);
  return response.body as {
    id: string;
    conversationId: string;
    senderId: string;
    content: string;
    createdAt: string;
  };
}

afterAll(async () => {
  for (const workspaceId of createdWorkspaceIds) {
    await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
  }
  for (const email of createdUserEmails) {
    await db.delete(users).where(eq(users.email, email));
  }
  for (const id of createdBotUserIds) {
    await db.delete(users).where(eq(users.id, id));
  }
});

async function taskFixture() {
  const owner = await registerUser("Backlog Owner");
  const recipient = await registerUser("Backlog Recipient");
  const workspace = await createSharedWorkspace(owner, recipient, "Backlog Tasks");
  const bot = await req("POST", "/bots/create", {
    name: "Backlog Hermes", kind: "hermes", workspaceId: workspace.id,
  }, owner.token);
  expect(bot.status).toBe(200);
  createdBotUserIds.push(bot.body.userId);
  const dm = await req("POST", "/conversations/dm", {
    workspaceId: workspace.id, otherUserId: bot.body.userId,
  }, recipient.token);
  expect(dm.status).toBe(200);
  const tasks = [];
  for (const title of ["Task A", "Task B"]) {
    const task = await req("POST", `/conversations/threads/${dm.body.id}`, {
      botId: bot.body.id, title,
    }, recipient.token);
    expect(task.status).toBe(200);
    tasks.push(task.body.id as string);
  }
  return { owner, recipient, workspace, bot: bot.body, conversationId: dm.body.id as string, taskA: tasks[0], taskB: tasks[1] };
}

describe("Task opening backlog", () => {
  test("tolerates deleted snapshot IDs but rejects sibling and cross-conversation IDs", async () => {
    const { recipient, bot, workspace, conversationId, taskA, taskB } = await taskFixture();
    const old = await sendMessage(bot.apiKey, conversationId, "Old", taskA);
    const deleted = await sendMessage(bot.apiKey, conversationId, "Deleted", taskA);
    const sibling = await sendMessage(bot.apiKey, conversationId, "Sibling", taskB);
    const general = await sendMessage(bot.apiKey, conversationId, "General");
    const page = await req("GET", `/messages/${conversationId}/task-page?threadId=${taskA}`, undefined, recipient.token);
    await db.delete(messages).where(eq(messages.id, deleted.id));
    const marked = await req("POST", `/activity/conversations/${conversationId}/read`, {
      messageIds: page.body.unreadMessageIds, threadId: taskA,
    }, recipient.token);
    expect(marked.status).toBe(200);
    expect(marked.body.totalUnreadMessages).toBe(2);
    for (const [messageId, threadId] of [[sibling.id, taskA], [general.id, taskA], [sibling.id, null]]) {
      const rejected = await req("POST", `/activity/conversations/${conversationId}/read`, {
        messageIds: [messageId], threadId,
      }, recipient.token);
      expect(rejected.status).toBe(400);
    }
    const wrongConversation = await req("POST", `/activity/conversations/${workspace.channelId}/read`, {
      messageIds: [sibling.id], threadId: taskB,
    }, recipient.token);
    expect(wrongConversation.status).toBe(400);
    const after = await req("GET", "/activity", undefined, recipient.token);
    expect(after.body.totalUnreadMessages).toBe(2);
    expect(new Set(after.body.items[0].unreadThreadIds)).toEqual(new Set([taskB, null]));
    expect(page.body.unreadMessageIds).toContain(old.id);
  });

  test("captures old unread IDs outside the newest page without consuming siblings or late commits", async () => {
    const { owner, recipient, bot, conversationId, taskA, taskB } = await taskFixture();
    const history = await db.transaction(async (tx) => {
      const rows = await tx.insert(messages).values(Array.from({ length: 245 }, (_, i) => ({
        conversationId, threadId: taskA, senderId: bot.userId,
        content: `History ${i}`, createdAt: new Date(Date.UTC(2026, 0, 1, 0, i)),
      }))).returning();
      for (const row of rows.slice(0, 225)) await recordMessageUnreads(tx, row);
      return rows;
    });
    const general = await sendMessage(bot.apiKey, conversationId, "General");
    const sibling = await sendMessage(bot.apiKey, conversationId, "Sibling", taskB);
    let release!: () => void;
    let staged!: () => void;
    const ready = new Promise<void>((resolve) => { staged = resolve; });
    const hold = new Promise<void>((resolve) => { release = resolve; });
    let lateId = "";
    const delayed = db.transaction(async (tx) => {
      const [row] = await tx.insert(messages).values({
        conversationId, threadId: taskA, senderId: bot.userId,
        content: "Backdated late commit", createdAt: new Date("2025-01-01"),
      }).returning();
      lateId = row.id;
      await recordMessageUnreads(tx, row);
      staged();
      await hold;
    });
    await ready;
    try {
      const ordinary = await req("GET", `/messages/${conversationId}?threadId=${taskA}&limit=20`, undefined, recipient.token);
      expect(Array.isArray(ordinary.body)).toBe(true);
      expect(ordinary.body).toHaveLength(20);
      const page = await req("GET", `/messages/${conversationId}/task-page?threadId=${taskA}&limit=20`, undefined, recipient.token);
      expect(page.status).toBe(200);
      expect(page.body.messages.map((m: { id: string }) => m.id)).toEqual(history.slice(-20).map((m) => m.id));
      expect(new Set(page.body.unreadMessageIds)).toEqual(new Set(history.slice(0, 225).map((m) => m.id)));
      expect((await req("GET", "/activity", undefined, recipient.token)).body.totalUnreadMessages).toBe(227);
      release();
      await delayed;
      const later = await sendMessage(bot.apiKey, conversationId, "Later reply", taskA);
      const ids = [...page.body.unreadMessageIds, ...page.body.messages.map((m: { id: string }) => m.id)];
      for (let i = 0; i < ids.length; i += 200) {
        const marked = await req("POST", `/activity/conversations/${conversationId}/read`, {
          messageIds: ids.slice(i, i + 200), threadId: taskA,
        }, recipient.token);
        expect(marked.status).toBe(200);
      }
      const remaining = await req("GET", `/messages/${conversationId}/task-page?threadId=${taskA}`, undefined, recipient.token);
      expect(new Set(remaining.body.unreadMessageIds)).toEqual(new Set([lateId, later.id]));
      const generalPage = await req("GET", `/messages/${conversationId}/task-page?unthreaded=true`, undefined, recipient.token);
      expect(generalPage.body.unreadMessageIds).toEqual([general.id]);
      const siblingPage = await req("GET", `/messages/${conversationId}/task-page?threadId=${taskB}`, undefined, recipient.token);
      expect(siblingPage.body.unreadMessageIds).toEqual([sibling.id]);
      expect((await req("GET", "/activity", undefined, recipient.token)).body.totalUnreadMessages).toBe(4);
      expect((await req("GET", `/messages/${conversationId}/task-page`, undefined, recipient.token)).status).toBe(400);
      expect((await req("GET", `/messages/${conversationId}/task-page?threadId=${taskA}`, undefined, owner.token)).status).toBe(403);
    } finally {
      release();
      await delayed;
    }
  });
});

describe("Activity unread persistence", () => {
  test("restores every unread task and General, deduplicating scopes and retaining siblings after exact reads", async () => {
    const owner = await registerUser("Task Owner");
    const recipient = await registerUser("Offline Task Recipient");
    const workspace = await createSharedWorkspace(owner, recipient, "Unread Tasks");
    const bot = await req("POST", "/bots/create", {
      name: "Unread Hermes", kind: "hermes", workspaceId: workspace.id,
    }, owner.token);
    expect(bot.status).toBe(200);
    createdBotUserIds.push(bot.body.userId);
    const dm = await req("POST", "/conversations/dm", {
      workspaceId: workspace.id, otherUserId: bot.body.userId,
    }, recipient.token);
    expect(dm.status).toBe(200);
    const taskA = await req("POST", `/conversations/threads/${dm.body.id}`, {
      botId: bot.body.id, title: "Task A",
    }, recipient.token);
    const taskB = await req("POST", `/conversations/threads/${dm.body.id}`, {
      botId: bot.body.id, title: "Task B",
    }, recipient.token);
    expect(taskA.status).toBe(200);
    expect(taskB.status).toBe(200);
    const firstA = await sendMessage(bot.body.apiKey, dm.body.id, "A first result", taskA.body.id);
    const general = await sendMessage(bot.body.apiKey, dm.body.id, "General result");
    await sendMessage(bot.body.apiKey, dm.body.id, "B result", taskB.body.id);
    const secondA = await sendMessage(bot.body.apiKey, dm.body.id, "A latest result", taskA.body.id);

    // There is no websocket client or client-side indicator state in this test.
    const restored = await req("GET", "/activity", undefined, recipient.token);
    expect(restored.status).toBe(200);
    expect(restored.body.totalUnreadMessages).toBe(4);
    expect(restored.body.items).toHaveLength(1);
    expect(restored.body.items[0].latestMessage.id).toBe(secondA.id);
    expect(restored.body.items[0].unreadThreadIds).toEqual([taskA.body.id, taskB.body.id, null]);
    expect((await req("GET", "/activity", undefined, owner.token)).body.items).toEqual([]);

    const partial = await req("POST", `/activity/conversations/${dm.body.id}/read`, {
      messageIds: [secondA.id],
    }, recipient.token);
    expect(partial.status).toBe(200);
    expect(new Set(partial.body.items[0].unreadThreadIds)).toEqual(new Set([taskA.body.id, taskB.body.id, null]));
    const readA = await req("POST", `/activity/conversations/${dm.body.id}/read`, {
      messageIds: [firstA.id],
    }, recipient.token);
    expect(readA.status).toBe(200);
    expect(readA.body.items[0].unreadThreadIds).toEqual([taskB.body.id, null]);
    expect(readA.body.totalUnreadMessages).toBe(2);
    const reopened = await req("GET", "/activity", undefined, recipient.token);
    expect(reopened.body).toEqual(readA.body);
    const readGeneral = await req("POST", `/activity/conversations/${dm.body.id}/read`, {
      messageIds: [general.id],
    }, recipient.token);
    expect(readGeneral.body.items[0].unreadThreadIds).toEqual([taskB.body.id]);
  });

  test("requires authentication", async () => {
    expect((await req("GET", "/activity")).status).toBe(401);
  });

  test("returns unread messages received across workspaces while no client is connected", async () => {
    const owner = await registerUser("Activity Owner");
    const recipient = await registerUser("Offline Recipient");
    const alpha = await createSharedWorkspace(owner, recipient, "Activity Alpha");
    const beta = await createSharedWorkspace(owner, recipient, "Activity Beta");

    const alphaMessage = await sendMessage(
      owner.token,
      alpha.channelId,
      "Alpha happened while you were away",
    );
    await sendMessage(owner.token, beta.channelId, "First beta update");
    const latestBetaMessage = await sendMessage(
      owner.token,
      beta.channelId,
      "Latest beta update",
    );

    const activity = await req("GET", "/activity", undefined, recipient.token);

    expect(activity.status).toBe(200);
    expect(activity.body.totalUnreadMessages).toBe(3);
    expect(activity.body.items).toHaveLength(2);
    expect(activity.body.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          conversationId: alpha.channelId,
          conversationType: "group",
          conversationName: "General",
          workspaceId: alpha.id,
          workspaceName: alpha.name,
          unreadCount: 1,
          latestMessage: expect.objectContaining({
            id: alphaMessage.id,
            senderId: owner.user.id,
            senderName: owner.user.name,
            content: alphaMessage.content,
          }),
        }),
        expect.objectContaining({
          conversationId: beta.channelId,
          conversationType: "group",
          conversationName: "General",
          workspaceId: beta.id,
          workspaceName: beta.name,
          unreadCount: 2,
          latestMessage: expect.objectContaining({
            id: latestBetaMessage.id,
            content: latestBetaMessage.content,
          }),
        }),
      ]),
    );
    expect(activity.body.items[0].latestMessage.id).toBe(latestBetaMessage.id);

    const stillUnread = await req("GET", "/activity", undefined, recipient.token);
    expect(stillUnread.body.totalUnreadMessages).toBe(3);
    expect((await req("GET", "/activity", undefined, owner.token)).body).toEqual({
      items: [],
      totalUnreadMessages: 0,
    });
  });

  test("marks exactly the rendered message IDs as read", async () => {
    const owner = await registerUser("Read Cursor Owner");
    const recipient = await registerUser("Read Cursor Recipient");
    const workspace = await createSharedWorkspace(
      owner,
      recipient,
      "Read Cursor Workspace",
    );
    const first = await sendMessage(owner.token, workspace.channelId, "First unread");
    const second = await sendMessage(owner.token, workspace.channelId, "Second unread");

    const partiallyRead = await req(
      "POST",
      `/activity/conversations/${workspace.channelId}/read`,
      { messageIds: [first.id] },
      recipient.token,
    );

    expect(partiallyRead.status).toBe(200);
    expect(partiallyRead.body.totalUnreadMessages).toBe(1);
    expect(partiallyRead.body.items).toEqual([
      expect.objectContaining({
        conversationId: workspace.channelId,
        unreadCount: 1,
        latestMessage: expect.objectContaining({ id: second.id }),
      }),
    ]);

    const fullyRead = await req(
      "POST",
      `/activity/conversations/${workspace.channelId}/read`,
      { messageIds: [second.id] },
      recipient.token,
    );
    expect(fullyRead).toMatchObject({
      status: 200,
      body: { items: [], totalUnreadMessages: 0 },
    });
  });

  test("keeps an earlier transaction unread when it commits after the rendered snapshot", async () => {
    const owner = await registerUser("Out Of Order Owner");
    const recipient = await registerUser("Out Of Order Recipient");
    const workspace = await createSharedWorkspace(
      owner,
      recipient,
      "Out Of Order Workspace",
    );

    let releaseEarlier!: () => void;
    let reportEarlierId!: (id: string) => void;
    const holdEarlier = new Promise<void>((resolve) => {
      releaseEarlier = resolve;
    });
    const earlierId = new Promise<string>((resolve) => {
      reportEarlierId = resolve;
    });
    const earlierTransaction = db.transaction(async (tx) => {
      const [message] = await tx
        .insert(messages)
        .values({
          conversationId: workspace.channelId,
          senderId: owner.user.id,
          content: "Started first, committed last",
          clientMessageId: crypto.randomUUID(),
        })
        .returning();
      await recordMessageUnreads(tx, message);
      reportEarlierId(message.id);
      await holdEarlier;
    });

    const uncommittedEarlierId = await earlierId;
    let earlierReleased = false;
    try {
      const renderedLater = await sendMessage(
        owner.token,
        workspace.channelId,
        "Rendered while the first transaction is hidden",
      );
      const snapshot = await req("GET", "/activity", undefined, recipient.token);
      expect(snapshot.body.items[0].latestMessage.id).toBe(renderedLater.id);
      expect(snapshot.body.totalUnreadMessages).toBe(1);

      releaseEarlier();
      earlierReleased = true;
      await earlierTransaction;

      const marked = await req(
        "POST",
        `/activity/conversations/${workspace.channelId}/read`,
        { messageIds: [renderedLater.id] },
        recipient.token,
      );
      expect(marked.status).toBe(200);
      expect(marked.body.totalUnreadMessages).toBe(1);
      expect(marked.body.items[0].latestMessage.id).toBe(uncommittedEarlierId);
    } finally {
      if (!earlierReleased) releaseEarlier();
      await earlierTransaction;
    }
  });

  test("rejects a rendered message from another conversation", async () => {
    const owner = await registerUser("Cursor Validation Owner");
    const recipient = await registerUser("Cursor Validation Recipient");
    const alpha = await createSharedWorkspace(owner, recipient, "Cursor Alpha");
    const beta = await createSharedWorkspace(owner, recipient, "Cursor Beta");
    const betaMessage = await sendMessage(owner.token, beta.channelId, "Wrong cursor");

    const response = await req(
      "POST",
      `/activity/conversations/${alpha.channelId}/read`,
      { messageIds: [betaMessage.id] },
      recipient.token,
    );

    expect(response).toMatchObject({
      status: 400,
      body: { error: "Rendered message does not belong to this conversation" },
    });
  });

  test("can explicitly clear an entire conversation", async () => {
    const owner = await registerUser("Conversation Clear Owner");
    const recipient = await registerUser("Conversation Clear Recipient");
    const workspace = await createSharedWorkspace(
      owner,
      recipient,
      "Conversation Clear Workspace",
    );
    await sendMessage(owner.token, workspace.channelId, "First unread");
    await sendMessage(owner.token, workspace.channelId, "Second unread");

    const response = await req(
      "POST",
      `/activity/conversations/${workspace.channelId}/read`,
      { all: true },
      recipient.token,
    );

    expect(response).toMatchObject({
      status: 200,
      body: { items: [], totalUnreadMessages: 0 },
    });
  });

  test("marks unread activity across every workspace as read", async () => {
    const owner = await registerUser("Read All Owner");
    const recipient = await registerUser("Read All Recipient");
    const alpha = await createSharedWorkspace(owner, recipient, "Read All Alpha");
    const beta = await createSharedWorkspace(owner, recipient, "Read All Beta");
    await sendMessage(owner.token, alpha.channelId, "Alpha unread");
    await sendMessage(owner.token, beta.channelId, "Beta unread");

    const cleared = await req(
      "POST",
      "/activity/read-all",
      {},
      recipient.token,
    );

    expect(cleared).toMatchObject({
      status: 200,
      body: { items: [], totalUnreadMessages: 0 },
    });
    const persisted = await req("GET", "/activity", undefined, recipient.token);
    expect(persisted.body).toEqual({ items: [], totalUnreadMessages: 0 });
  });

  test("does not expose workspace-DM activity after membership removal", async () => {
    const owner = await registerUser("Membership Owner");
    const member = await registerUser("Removed Member");
    const workspace = await createSharedWorkspace(owner, member, "Membership Activity");
    const dm = await req(
      "POST",
      "/conversations/dm",
      { workspaceId: workspace.id, otherUserId: member.user.id },
      owner.token,
    );
    expect(dm.status).toBe(200);

    await sendMessage(owner.token, dm.body.id, "Before removal");
    expect((await req("GET", "/activity", undefined, member.token)).body)
      .toMatchObject({ totalUnreadMessages: 1 });

    const removed = await req(
      "DELETE",
      `/workspaces/${workspace.id}/members/${member.user.id}`,
      undefined,
      owner.token,
    );
    expect(removed.status).toBe(200);
    expect((await req("GET", "/activity", undefined, member.token)).body).toEqual({
      items: [],
      totalUnreadMessages: 0,
    });

    await sendMessage(owner.token, dm.body.id, "After removal");
    expect((await req("GET", "/activity", undefined, member.token)).body).toEqual({
      items: [],
      totalUnreadMessages: 0,
    });

    const mark = await req(
      "POST",
      `/activity/conversations/${dm.body.id}/read`,
      { all: true },
      member.token,
    );
    expect(mark.status).toBe(403);
  });
});
