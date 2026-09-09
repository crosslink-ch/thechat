import { afterAll, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { Elysia } from "elysia";
import { activityRoutes } from "./index";
import { authRoutes } from "../auth";
import { conversationRoutes } from "../conversations";
import { db } from "../db";
import { messages, users, workspaces } from "../db/schema";
import { recordMessageUnreads } from "../services/activity";
import { inviteRoutes } from "../invites";
import { messageRoutes } from "../messages";
import { workspaceRoutes } from "../workspaces";

const app = new Elysia()
  .use(authRoutes)
  .use(workspaceRoutes)
  .use(inviteRoutes)
  .use(conversationRoutes)
  .use(messageRoutes)
  .use(activityRoutes);

const createdUserEmails: string[] = [];
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

async function sendMessage(token: string, conversationId: string, content: string) {
  const response = await req(
    "POST",
    `/messages/${conversationId}`,
    { content },
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
});

describe("Activity unread persistence", () => {
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
