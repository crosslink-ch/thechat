import { afterAll, describe, expect, test } from "bun:test";
import crypto from "crypto";
import { and, eq } from "drizzle-orm";
import { Elysia } from "elysia";
import { authRoutes } from "../auth";
import { botRoutes } from "../bots";
import { conversationRoutes } from "../conversations";
import { botWorkspaceInviteRoutes } from "./index";
import { db } from "../db";
import {
  botWorkspaceInvites,
  conversationParticipants,
  conversations,
  users,
  workspaceMembers,
  workspaces,
} from "../db/schema";
import { workspaceRoutes } from "../workspaces";
import { requestBotForWorkspace } from "../services/bot-workspace-memberships";

const app = new Elysia()
  .use(authRoutes)
  .use(workspaceRoutes)
  .use(conversationRoutes)
  .use(botRoutes)
  .use(botWorkspaceInviteRoutes);

const createdUserEmails: string[] = [];
const createdWorkspaceIds: string[] = [];

async function request(
  method: string,
  path: string,
  body?: unknown,
  token?: string,
) {
  const response = await app.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers: {
        ...(body ? { "content-type": "application/json" } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    }),
  );
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null,
  };
}

async function register(name: string) {
  const email = `bot-workspace-${crypto.randomUUID()}@test.local`;
  createdUserEmails.push(email);
  const response = await request("POST", "/auth/register", {
    name,
    email,
    password: "password123",
  });
  expect(response.status).toBe(200);
  return {
    token: response.body.accessToken as string,
    user: response.body.user as { id: string; name: string; email: string },
  };
}

async function createWorkspace(token: string, name: string) {
  const response = await request("POST", "/workspaces/create", { name }, token);
  expect(response.status).toBe(200);
  createdWorkspaceIds.push(response.body.id);
  return response.body as { id: string };
}

async function createBot(token: string, name: string) {
  const response = await request(
    "POST",
    "/bots/create",
    { name, kind: "webhook" },
    token,
  );
  expect(response.status).toBe(200);
  return response.body as { id: string; userId: string };
}

afterAll(async () => {
  for (const workspaceId of createdWorkspaceIds) {
    await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
  }
  for (const email of createdUserEmails) {
    await db.delete(users).where(eq(users.email, email));
  }
});

describe("bot workspace membership approvals", () => {
  test("adds joining bots to public channels but not private channels", async () => {
    const owner = await register("Private bot workspace owner");
    const workspace = await createWorkspace(
      owner.token,
      "Private bot membership workspace",
    );
    const privateChannel = await request(
      "POST",
      "/conversations/channel",
      {
        workspaceId: workspace.id,
        name: "Private Humans",
        isPrivate: true,
        memberIds: [],
      },
      owner.token,
    );
    expect(privateChannel.status).toBe(200);
    const bot = await createBot(owner.token, "Private membership helper");

    const response = await request(
      "POST",
      `/workspaces/${workspace.id}/bots`,
      { botId: bot.id },
      owner.token,
    );
    expect(response.status).toBe(200);

    const privateParticipation = await db
      .select({ userId: conversationParticipants.userId })
      .from(conversationParticipants)
      .where(
        and(
          eq(
            conversationParticipants.conversationId,
            privateChannel.body.id,
          ),
          eq(conversationParticipants.userId, bot.userId),
        ),
      );
    expect(privateParticipation).toHaveLength(0);

    const [generalChannel] = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(
        and(
          eq(conversations.workspaceId, workspace.id),
          eq(conversations.name, "general"),
        ),
      )
      .limit(1);
    const publicParticipation = await db
      .select({ userId: conversationParticipants.userId })
      .from(conversationParticipants)
      .where(
        and(
          eq(conversationParticipants.conversationId, generalChannel.id),
          eq(conversationParticipants.userId, bot.userId),
        ),
      );
    expect(publicParticipation).toHaveLength(1);
  });

  test("a workspace admin adds their own bot immediately", async () => {
    const owner = await register("Workspace owner");
    const workspace = await createWorkspace(owner.token, "Owned bot workspace");
    const bot = await createBot(owner.token, "Owned helper");

    const response = await request(
      "POST",
      `/workspaces/${workspace.id}/bots`,
      { botId: bot.id },
      owner.token,
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "added", botId: bot.id });

    const [membership] = await db
      .select()
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspace.id),
          eq(workspaceMembers.userId, bot.userId),
        ),
      );
    expect(membership?.role).toBe("member");

    const [channel] = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.workspaceId, workspace.id));
    const [participant] = await db
      .select()
      .from(conversationParticipants)
      .where(
        and(
          eq(conversationParticipants.conversationId, channel.id),
          eq(conversationParticipants.userId, bot.userId),
        ),
      );
    expect(participant?.role).toBe("member");
  });

  test("a non-owned bot requires its owner to approve", async () => {
    const workspaceOwner = await register("Requesting admin");
    const botOwner = await register("Bot owner");
    const stranger = await register("Stranger");
    const workspace = await createWorkspace(
      workspaceOwner.token,
      "Approval workspace",
    );
    const bot = await createBot(botOwner.token, "Outside helper");

    const requested = await request(
      "POST",
      `/workspaces/${workspace.id}/bots`,
      { botId: bot.id },
      workspaceOwner.token,
    );
    expect(requested.status).toBe(200);
    expect(requested.body.status).toBe("pending");
    expect(requested.body.invite).toMatchObject({
      workspaceId: workspace.id,
      botId: bot.id,
      requesterId: workspaceOwner.user.id,
      status: "pending",
    });

    const beforeApproval = await db
      .select()
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspace.id),
          eq(workspaceMembers.userId, bot.userId),
        ),
      );
    expect(beforeApproval).toHaveLength(0);

    const ownerInbox = await request(
      "GET",
      "/bot-workspace-invites/pending",
      undefined,
      botOwner.token,
    );
    expect(ownerInbox.status).toBe(200);
    expect(ownerInbox.body).toHaveLength(1);
    expect(ownerInbox.body[0].id).toBe(requested.body.invite.id);
    expect(ownerInbox.body[0]).not.toHaveProperty("ownerId");

    const unauthorized = await request(
      "POST",
      "/bot-workspace-invites/accept",
      { inviteId: requested.body.invite.id },
      stranger.token,
    );
    expect(unauthorized.status).toBe(403);

    const accepted = await request(
      "POST",
      "/bot-workspace-invites/accept",
      { inviteId: requested.body.invite.id },
      botOwner.token,
    );
    expect(accepted.status).toBe(200);
    expect(accepted.body).toEqual({
      success: true,
      workspaceId: workspace.id,
      botId: bot.id,
    });

    const [membership] = await db
      .select()
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspace.id),
          eq(workspaceMembers.userId, bot.userId),
        ),
      );
    expect(membership).toBeDefined();

    const ownerInboxAfter = await request(
      "GET",
      "/bot-workspace-invites/pending",
      undefined,
      botOwner.token,
    );
    expect(ownerInboxAfter.body).toHaveLength(0);
  });

  test("pending requests can be declined or cancelled and cannot be duplicated", async () => {
    const workspaceOwner = await register("Request owner");
    const botOwner = await register("Approval owner");
    const workspace = await createWorkspace(workspaceOwner.token, "Pending workspace");
    const bot = await createBot(botOwner.token, "Pending helper");

    const first = await request(
      "POST",
      `/workspaces/${workspace.id}/bots`,
      { botId: bot.id },
      workspaceOwner.token,
    );
    const duplicate = await request(
      "POST",
      `/workspaces/${workspace.id}/bots`,
      { botId: bot.id },
      workspaceOwner.token,
    );
    expect(duplicate.status).toBe(409);

    const workspacePending = await request(
      "GET",
      `/workspaces/${workspace.id}/bot-invites`,
      undefined,
      workspaceOwner.token,
    );
    expect(workspacePending.status).toBe(200);
    expect(workspacePending.body.map((invite: { id: string }) => invite.id)).toContain(
      first.body.invite.id,
    );

    const declined = await request(
      "POST",
      "/bot-workspace-invites/decline",
      { inviteId: first.body.invite.id },
      botOwner.token,
    );
    expect(declined.status).toBe(200);

    const second = await request(
      "POST",
      `/workspaces/${workspace.id}/bots`,
      { botId: bot.id },
      workspaceOwner.token,
    );
    expect(second.status).toBe(200);
    expect(second.body.status).toBe("pending");

    const cancelled = await request(
      "DELETE",
      `/workspaces/${workspace.id}/bot-invites/${second.body.invite.id}`,
      undefined,
      workspaceOwner.token,
    );
    expect(cancelled.status).toBe(200);

    const statuses = await db
      .select({ status: botWorkspaceInvites.status })
      .from(botWorkspaceInvites)
      .where(
        and(
          eq(botWorkspaceInvites.workspaceId, workspace.id),
          eq(botWorkspaceInvites.botId, bot.id),
        ),
      );
    expect(statuses.map((row) => row.status).sort()).toEqual([
      "cancelled",
      "declined",
    ]);
  });

  test("regular members cannot request bots and non-owners cannot bypass approval", async () => {
    const workspaceOwner = await register("Workspace owner");
    const member = await register("Regular member");
    const botOwner = await register("External owner");
    const workspace = await createWorkspace(workspaceOwner.token, "Protected workspace");
    const bot = await createBot(botOwner.token, "Protected helper");
    await db.insert(workspaceMembers).values({
      workspaceId: workspace.id,
      userId: member.user.id,
      role: "member",
    });

    const memberRequest = await request(
      "POST",
      `/workspaces/${workspace.id}/bots`,
      { botId: bot.id },
      member.token,
    );
    expect(memberRequest.status).toBe(403);

    const bypass = await request(
      "POST",
      `/bots/${bot.id}/workspaces`,
      { workspaceId: workspace.id },
      workspaceOwner.token,
    );
    expect(bypass.status).toBe(403);
  });

  test("approval is rejected when the requester is no longer an admin", async () => {
    const workspaceOwner = await register("Workspace owner");
    const admin = await register("Temporary admin");
    const botOwner = await register("Bot owner");
    const workspace = await createWorkspace(workspaceOwner.token, "Stale request workspace");
    const bot = await createBot(botOwner.token, "Stale request helper");
    await db.insert(workspaceMembers).values({
      workspaceId: workspace.id,
      userId: admin.user.id,
      role: "admin",
    });

    const requested = await request(
      "POST",
      `/workspaces/${workspace.id}/bots`,
      { botId: bot.id },
      admin.token,
    );
    await db
      .update(workspaceMembers)
      .set({ role: "member" })
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspace.id),
          eq(workspaceMembers.userId, admin.user.id),
        ),
      );

    const accepted = await request(
      "POST",
      "/bot-workspace-invites/accept",
      { inviteId: requested.body.invite.id },
      botOwner.token,
    );
    expect(accepted.status).toBe(409);
    expect(accepted.body.error).toContain("no longer a workspace admin");
  });

  test("workspace admins and bot owners can remove a bot, regular members cannot", async () => {
    const workspaceOwner = await register("Workspace owner");
    const member = await register("Workspace member");
    const botOwner = await register("Bot owner");
    const workspace = await createWorkspace(workspaceOwner.token, "Removal workspace");
    const bot = await createBot(botOwner.token, "Removal helper");
    await db.insert(workspaceMembers).values({
      workspaceId: workspace.id,
      userId: member.user.id,
      role: "member",
    });

    const requested = await request(
      "POST",
      `/workspaces/${workspace.id}/bots`,
      { botId: bot.id },
      workspaceOwner.token,
    );
    await request(
      "POST",
      "/bot-workspace-invites/accept",
      { inviteId: requested.body.invite.id },
      botOwner.token,
    );

    const forbidden = await request(
      "DELETE",
      `/workspaces/${workspace.id}/bots/${bot.id}`,
      undefined,
      member.token,
    );
    expect(forbidden.status).toBe(403);

    const removed = await request(
      "DELETE",
      `/workspaces/${workspace.id}/bots/${bot.id}`,
      undefined,
      workspaceOwner.token,
    );
    expect(removed.status).toBe(200);

    const remaining = await db
      .select()
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspace.id),
          eq(workspaceMembers.userId, bot.userId),
        ),
      );
    expect(remaining).toHaveLength(0);
  });

  test("blocks bot deletion until pending requests are resolved", async () => {
    const workspaceOwner = await register("Deletion requester");
    const botOwner = await register("Deletion bot owner");
    const workspace = await createWorkspace(
      workspaceOwner.token,
      "Deletion request workspace",
    );
    const bot = await createBot(botOwner.token, "Deletion pending helper");
    const requested = await request(
      "POST",
      `/workspaces/${workspace.id}/bots`,
      { botId: bot.id },
      workspaceOwner.token,
    );

    const blocked = await request(
      "DELETE",
      `/bots/${bot.id}`,
      undefined,
      botOwner.token,
    );
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toContain("resolve pending workspace requests");

    const declined = await request(
      "POST",
      "/bot-workspace-invites/decline",
      { inviteId: requested.body.invite.id },
      botOwner.token,
    );
    expect(declined.status).toBe(200);
    const deleted = await request(
      "DELETE",
      `/bots/${bot.id}`,
      undefined,
      botOwner.token,
    );
    expect(deleted.status).toBe(200);
  });

  test("blocks bot deletion until workspace memberships are removed", async () => {
    const owner = await register("Attached bot owner");
    const workspace = await createWorkspace(owner.token, "Attached bot workspace");
    const bot = await createBot(owner.token, "Attached helper");
    const attached = await request(
      "POST",
      `/workspaces/${workspace.id}/bots`,
      { botId: bot.id },
      owner.token,
    );
    expect(attached.status).toBe(200);

    const blocked = await request(
      "DELETE",
      `/bots/${bot.id}`,
      undefined,
      owner.token,
    );
    expect(blocked.status).toBe(409);

    const removed = await request(
      "DELETE",
      `/workspaces/${workspace.id}/bots/${bot.id}`,
      undefined,
      owner.token,
    );
    expect(removed.status).toBe(200);
    const deleted = await request(
      "DELETE",
      `/bots/${bot.id}`,
      undefined,
      owner.token,
    );
    expect(deleted.status).toBe(200);
  });

  test("serializes direct bot attachment with channel participant snapshots", async () => {
    const owner = await register("Serialization owner");
    const workspace = await createWorkspace(owner.token, "Serialization workspace");
    const bot = await createBot(owner.token, "Serialization helper");

    let signalLocked!: () => void;
    let releaseLock!: () => void;
    const locked = new Promise<void>((resolve) => {
      signalLocked = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });

    const attachment = requestBotForWorkspace(
      workspace.id,
      bot.id,
      owner.user.id,
      {
        afterWorkspaceLocked: async () => {
          signalLocked();
          await release;
        },
      },
    );
    await locked;

    let channelSettled = false;
    const channelRequest = request(
      "POST",
      "/conversations/channel",
      { workspaceId: workspace.id, name: "Bot Snapshot" },
      owner.token,
    ).finally(() => {
      channelSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(channelSettled).toBe(false);

    releaseLock();
    const [attached, channel] = await Promise.all([attachment, channelRequest]);
    expect(attached.status).toBe("added");
    expect(channel.status).toBe(200);

    const participant = await db
      .select({ userId: conversationParticipants.userId })
      .from(conversationParticipants)
      .where(
        and(
          eq(conversationParticipants.conversationId, channel.body.id),
          eq(conversationParticipants.userId, bot.userId),
        ),
      );
    expect(participant).toHaveLength(1);
  });
});
