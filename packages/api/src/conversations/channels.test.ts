import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import { and, eq } from "drizzle-orm";
import { Elysia } from "elysia";
import { authRoutes } from "../auth";
import { conversationRoutes } from "../conversations";
import { db } from "../db";
import {
  attachments,
  botInvocations,
  bots,
  conversationParticipants,
  eventOutbox,
  messages,
  users,
  workspaces,
} from "../db/schema";
import { inviteRoutes } from "../invites";
import { messageRoutes } from "../messages";
import { workspaceRoutes } from "../workspaces";
import { createChatMessageSentV1 } from "../events/envelope";
import { enqueueDomainEvent } from "../events/outbox";
import {
  createChannel,
  createConversationThread,
  renameChannel,
} from "../services/conversations";
import { sendMessage } from "../services/messages";
import { failTimedOutHermesDispatchesForConversation } from "../services/bot-runtime";
import { addBotToWorkspace, removeBotFromWorkspace } from "../services/bots";
import { removeMember, updateMemberRole } from "../services/workspaces";
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
  .use(messageRoutes);

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

async function req(
  method: string,
  path: string,
  body?: unknown,
  token?: string,
) {
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
  const email = `channel-${crypto.randomUUID()}@test.com`;
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

async function createWorkspace(ownerToken: string, name: string) {
  const response = await req(
    "POST",
    "/workspaces/create",
    { name },
    ownerToken,
  );
  expect(response.status).toBe(200);
  createdWorkspaceIds.push(response.body.id);
  return response.body.id as string;
}

async function addMember(
  workspaceId: string,
  ownerToken: string,
  member: { token: string; user: { email: string } },
) {
  const invite = await req(
    "POST",
    "/invites/create",
    { workspaceId, email: member.user.email },
    ownerToken,
  );
  expect(invite.status).toBe(200);
  const accepted = await req(
    "POST",
    "/invites/accept",
    { inviteId: invite.body.id },
    member.token,
  );
  expect(accepted.status).toBe(200);
}

async function createHermesBot(ownerId: string) {
  const [botUser] = await db
    .insert(users)
    .values({ name: `Channel Bot ${crypto.randomUUID()}`, type: "bot" })
    .returning({ id: users.id });
  createdBotUserIds.push(botUser.id);
  const [bot] = await db
    .insert(bots)
    .values({
      userId: botUser.id,
      ownerId,
      kind: "hermes",
      webhookSecret: `whsec_${crypto.randomBytes(32).toString("hex")}`,
    })
    .returning({ id: bots.id });
  return { ...bot, userId: botUser.id };
}

afterAll(async () => {
  for (const workspaceId of createdWorkspaceIds) {
    await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
  }
  for (const email of createdUserEmails) {
    const [user] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    if (user) await db.delete(users).where(eq(users.id, user.id));
  }
  for (const userId of createdBotUserIds) {
    await db.delete(users).where(eq(users.id, userId));
  }
  await unsubscribeRealtime?.();
  await closeRealtimeBusForTests();
});

describe("Channel management", () => {
  test("members create channels while owners and admins rename or delete them", async () => {
    const owner = await registerUser("Channel Owner");
    const member = await registerUser("Channel Member");
    const outsider = await registerUser("Channel Outsider");
    const workspaceId = await createWorkspace(
      owner.token,
      `Channel Management ${crypto.randomUUID()}`,
    );
    await addMember(workspaceId, owner.token, member);

    const created = await req(
      "POST",
      "/conversations/channel",
      { workspaceId, name: "  Product   Updates  " },
      member.token,
    );
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({
      workspaceId,
      name: "product-updates",
      title: "Product Updates",
    });
    const channelId = created.body.id as string;
    expect(
      realtimeEvents.find(
        (event) =>
          event.type === "ws.event" &&
          event.event.type === "channel_created" &&
          event.event.channel.id === channelId,
      ),
    ).toMatchObject({
      targetUserIds: expect.arrayContaining([owner.user.id, member.user.id]),
      event: {
        type: "channel_created",
        workspaceId,
        channel: { id: channelId, name: "product-updates" },
      },
    });

    const detail = await req(
      "GET",
      `/workspaces/${workspaceId}`,
      undefined,
      owner.token,
    );
    expect(detail.body.channels).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: channelId, name: "product-updates" }),
      ]),
    );
    expect(
      (await req("GET", `/conversations/detail/${channelId}`, undefined, member.token))
        .status,
    ).toBe(200);
    expect(
      (await req("GET", `/conversations/detail/${channelId}`, undefined, outsider.token))
        .status,
    ).toBe(403);

    const duplicate = await req(
      "POST",
      "/conversations/channel",
      { workspaceId, name: "Product Updates" },
      owner.token,
    );
    expect(duplicate).toMatchObject({
      status: 409,
      body: { error: "A channel with this name already exists" },
    });

    const invalid = await req(
      "POST",
      "/conversations/channel",
      { workspaceId, name: "✨" },
      owner.token,
    );
    expect(invalid).toMatchObject({
      status: 400,
      body: { error: "Channel name must include at least one letter or number" },
    });

    const memberRename = await req(
      "PATCH",
      `/conversations/channel/${channelId}`,
      { name: "Engineering" },
      member.token,
    );
    expect(memberRename.status).toBe(403);

    const renamed = await req(
      "PATCH",
      `/conversations/channel/${channelId}`,
      { name: "Product & Design" },
      owner.token,
    );
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({
      id: channelId,
      name: "product-design",
      title: "Product & Design",
    });

    const collision = await req(
      "PATCH",
      `/conversations/channel/${channelId}`,
      { name: "General" },
      owner.token,
    );
    expect(collision.status).toBe(409);

    expect(
      (
        await req(
          "DELETE",
          `/conversations/channel/${channelId}`,
          undefined,
          outsider.token,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await req(
          "DELETE",
          `/conversations/channel/${channelId}`,
          undefined,
          member.token,
        )
      ).status,
    ).toBe(403);

    const promoted = await req(
      "POST",
      `/workspaces/${workspaceId}/members/${member.user.id}/role`,
      { role: "admin" },
      owner.token,
    );
    expect(promoted.status).toBe(200);

    const adminRenamed = await req(
      "PATCH",
      `/conversations/channel/${channelId}`,
      { name: "Engineering Hub" },
      member.token,
    );
    expect(adminRenamed).toMatchObject({
      status: 200,
      body: { id: channelId, name: "engineering-hub", title: "Engineering Hub" },
    });

    const message = await req(
      "POST",
      `/messages/${channelId}`,
      { content: "This history is intentionally deleted with the channel." },
      owner.token,
    );
    expect(message.status).toBe(200);

    const deleted = await req(
      "DELETE",
      `/conversations/channel/${channelId}`,
      undefined,
      member.token,
    );
    expect(deleted).toMatchObject({
      status: 200,
      body: { ok: true, deletedChannelId: channelId },
    });

    const afterDelete = await req(
      "GET",
      `/workspaces/${workspaceId}`,
      undefined,
      owner.token,
    );
    expect(afterDelete.body.channels.some((channel: any) => channel.id === channelId)).toBe(
      false,
    );
    expect(
      (await req("GET", `/conversations/detail/${channelId}`, undefined, owner.token))
        .status,
    ).toBe(403);
    expect(
      realtimeEvents
        .filter((event) => event.type === "ws.event")
        .map((event) => event.event.type)
        .filter((type) => type.startsWith("channel_")),
    ).toEqual([
      "channel_created",
      "channel_renamed",
      "channel_renamed",
      "channel_deleted",
    ]);
  });

  test("serializes channel creation with member removal and rejects orphaned group access", async () => {
    const owner = await registerUser("Channel Race Owner");
    const member = await registerUser("Channel Race Member");
    const workspaceId = await createWorkspace(
      owner.token,
      `Channel Race ${crypto.randomUUID()}`,
    );
    await addMember(workspaceId, owner.token, member);

    let releaseCreate!: () => void;
    const createGate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    let resolveCreateLocked!: () => void;
    const createLocked = new Promise<void>((resolve) => {
      resolveCreateLocked = resolve;
    });
    const creating = createChannel(
      workspaceId,
      "Race Protected",
      member.user.id,
      {
        afterWorkspaceLocked: async () => {
          resolveCreateLocked();
          await createGate;
        },
      },
    );
    await createLocked;

    let removalAcquiredWorkspaceLock = false;
    const removing = removeMember(
      workspaceId,
      owner.user.id,
      member.user.id,
      {
        afterWorkspaceLocked: async () => {
          removalAcquiredWorkspaceLock = true;
        },
      },
    );
    await Bun.sleep(100);
    const removalWasBlocked = !removalAcquiredWorkspaceLock;
    releaseCreate();

    const channel = await creating;
    await removing;
    expect(removalWasBlocked).toBe(true);
    expect(removalAcquiredWorkspaceLock).toBe(true);

    const remainingParticipants = await db
      .select({ userId: conversationParticipants.userId })
      .from(conversationParticipants)
      .where(
        and(
          eq(conversationParticipants.conversationId, channel.id),
          eq(conversationParticipants.userId, member.user.id),
        ),
      );
    expect(remainingParticipants).toHaveLength(0);

    // Defense in depth: even a legacy/corrupt participant row cannot restore
    // group access after workspace membership has been removed.
    await db.insert(conversationParticipants).values({
      conversationId: channel.id,
      userId: member.user.id,
      role: "member",
    });
    expect(
      (
        await req(
          "GET",
          `/conversations/detail/${channel.id}`,
          undefined,
          member.token,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await req(
          "POST",
          `/messages/${channel.id}`,
          { content: "This orphaned participant must stay denied." },
          member.token,
        )
      ).status,
    ).toBe(403);
  });

  test("revalidates creation after member removal wins the workspace lock", async () => {
    const owner = await registerUser("Removal First Owner");
    const member = await registerUser("Removal First Member");
    const workspaceId = await createWorkspace(
      owner.token,
      `Removal First ${crypto.randomUUID()}`,
    );
    await addMember(workspaceId, owner.token, member);

    let releaseRemoval!: () => void;
    const removalGate = new Promise<void>((resolve) => {
      releaseRemoval = resolve;
    });
    let resolveRemovalLocked!: () => void;
    const removalLocked = new Promise<void>((resolve) => {
      resolveRemovalLocked = resolve;
    });
    const removing = removeMember(
      workspaceId,
      owner.user.id,
      member.user.id,
      {
        afterWorkspaceLocked: async () => {
          resolveRemovalLocked();
          await removalGate;
        },
      },
    );
    await removalLocked;

    let creationAcquiredWorkspaceLock = false;
    const creationResult = createChannel(
      workspaceId,
      "Must Not Exist",
      member.user.id,
      {
        afterWorkspaceLocked: async () => {
          creationAcquiredWorkspaceLock = true;
        },
      },
    ).then(
      () => ({ status: "fulfilled" as const }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );
    await Bun.sleep(100);
    expect(creationAcquiredWorkspaceLock).toBe(false);
    releaseRemoval();
    await removing;

    const outcome = await creationResult;
    expect(creationAcquiredWorkspaceLock).toBe(true);
    expect(outcome.status).toBe("rejected");
    if (outcome.status === "rejected") {
      expect(outcome.error).toMatchObject({ status: 403 });
    }

    const workspace = await req(
      "GET",
      `/workspaces/${workspaceId}`,
      undefined,
      owner.token,
    );
    expect(
      workspace.body.channels.some(
        (channel: any) => channel.name === "must-not-exist",
      ),
    ).toBe(false);
  });

  test("removal-first serialization rejects channel messages and thread creation", async () => {
    const owner = await registerUser("Write Race Owner");
    const member = await registerUser("Write Race Member");
    const workspaceId = await createWorkspace(
      owner.token,
      `Write Race ${crypto.randomUUID()}`,
    );
    await addMember(workspaceId, owner.token, member);
    const channel = await createChannel(
      workspaceId,
      "Write Race",
      owner.user.id,
    );
    const bot = await createHermesBot(owner.user.id);
    await addBotToWorkspace(bot.id, workspaceId, owner.user.id);

    let releaseRemoval!: () => void;
    const removalGate = new Promise<void>((resolve) => {
      releaseRemoval = resolve;
    });
    let resolveRemovalLocked!: () => void;
    const removalLocked = new Promise<void>((resolve) => {
      resolveRemovalLocked = resolve;
    });
    const removing = removeMember(
      workspaceId,
      owner.user.id,
      member.user.id,
      {
        afterWorkspaceLocked: async () => {
          resolveRemovalLocked();
          await removalGate;
        },
      },
    );
    await removalLocked;

    let sendAcquiredWorkspaceLock = false;
    let threadAcquiredWorkspaceLock = false;
    const sending = sendMessage(
      channel.id,
      member.user.id,
      "Write Race Member",
      "This stale write must not commit",
      {
        afterWorkspaceLocked: async () => {
          sendAcquiredWorkspaceLock = true;
        },
      },
    );
    const creatingThread = createConversationThread(
      channel.id,
      member.user.id,
      { botId: bot.id, title: "This stale thread must not commit" },
      {
        afterWorkspaceLocked: async () => {
          threadAcquiredWorkspaceLock = true;
        },
      },
    );
    const outcomes = Promise.all([
      sending.then(
        () => ({ status: "fulfilled" as const }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      ),
      creatingThread.then(
        () => ({ status: "fulfilled" as const }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      ),
    ]);

    await Bun.sleep(100);
    expect(sendAcquiredWorkspaceLock).toBe(false);
    expect(threadAcquiredWorkspaceLock).toBe(false);
    releaseRemoval();
    await removing;

    for (const outcome of await outcomes) {
      expect(outcome.status).toBe("rejected");
      if (outcome.status === "rejected") {
        expect(outcome.error).toMatchObject({ status: 403 });
      }
    }
    expect(sendAcquiredWorkspaceLock).toBe(true);
    expect(threadAcquiredWorkspaceLock).toBe(true);
  });

  test("serializes bot membership changes with channel participant snapshots", async () => {
    const owner = await registerUser("Bot Race Owner");
    const workspaceId = await createWorkspace(
      owner.token,
      `Bot Race ${crypto.randomUUID()}`,
    );
    const bot = await createHermesBot(owner.user.id);

    let releaseAdd!: () => void;
    const addGate = new Promise<void>((resolve) => {
      releaseAdd = resolve;
    });
    let resolveAddLocked!: () => void;
    const addLocked = new Promise<void>((resolve) => {
      resolveAddLocked = resolve;
    });
    const adding = addBotToWorkspace(bot.id, workspaceId, owner.user.id, {
      afterWorkspaceLocked: async () => {
        resolveAddLocked();
        await addGate;
      },
    });
    await addLocked;

    let createAfterAddAcquiredLock = false;
    const createAfterAdd = createChannel(
      workspaceId,
      "Bot Added First",
      owner.user.id,
      {
        afterWorkspaceLocked: async () => {
          createAfterAddAcquiredLock = true;
        },
      },
    );
    await Bun.sleep(100);
    expect(createAfterAddAcquiredLock).toBe(false);
    releaseAdd();
    await adding;
    const addedFirstChannel = await createAfterAdd;
    expect(createAfterAddAcquiredLock).toBe(true);
    expect(
      await db
        .select({ userId: conversationParticipants.userId })
        .from(conversationParticipants)
        .where(
          and(
            eq(conversationParticipants.conversationId, addedFirstChannel.id),
            eq(conversationParticipants.userId, bot.userId),
          ),
        ),
    ).toHaveLength(1);

    let releaseRemove!: () => void;
    const removeGate = new Promise<void>((resolve) => {
      releaseRemove = resolve;
    });
    let resolveRemoveLocked!: () => void;
    const removeLocked = new Promise<void>((resolve) => {
      resolveRemoveLocked = resolve;
    });
    const removing = removeBotFromWorkspace(
      bot.id,
      workspaceId,
      owner.user.id,
      {
        afterWorkspaceLocked: async () => {
          resolveRemoveLocked();
          await removeGate;
        },
      },
    );
    await removeLocked;

    let createAfterRemoveAcquiredLock = false;
    const createAfterRemove = createChannel(
      workspaceId,
      "Bot Removed First",
      owner.user.id,
      {
        afterWorkspaceLocked: async () => {
          createAfterRemoveAcquiredLock = true;
        },
      },
    );
    await Bun.sleep(100);
    expect(createAfterRemoveAcquiredLock).toBe(false);
    releaseRemove();
    await removing;
    const removedFirstChannel = await createAfterRemove;
    expect(createAfterRemoveAcquiredLock).toBe(true);
    expect(
      await db
        .select({ userId: conversationParticipants.userId })
        .from(conversationParticipants)
        .where(
          and(
            eq(conversationParticipants.conversationId, removedFirstChannel.id),
            eq(conversationParticipants.userId, bot.userId),
          ),
        ),
    ).toHaveLength(0);
  });

  test("serializes manager demotion with channel authorization revalidation", async () => {
    const owner = await registerUser("Demotion Race Owner");
    const admin = await registerUser("Demotion Race Admin");
    const workspaceId = await createWorkspace(
      owner.token,
      `Demotion Race ${crypto.randomUUID()}`,
    );
    await addMember(workspaceId, owner.token, admin);
    await updateMemberRole(workspaceId, owner.user.id, admin.user.id, "admin");
    const workspace = await req(
      "GET",
      `/workspaces/${workspaceId}`,
      undefined,
      owner.token,
    );
    const channelId = workspace.body.channels[0].id as string;

    let releaseDemotion!: () => void;
    const demotionGate = new Promise<void>((resolve) => {
      releaseDemotion = resolve;
    });
    let resolveDemotionLocked!: () => void;
    const demotionLocked = new Promise<void>((resolve) => {
      resolveDemotionLocked = resolve;
    });
    const demoting = updateMemberRole(
      workspaceId,
      owner.user.id,
      admin.user.id,
      "member",
      {
        afterWorkspaceLocked: async () => {
          resolveDemotionLocked();
          await demotionGate;
        },
      },
    );
    await demotionLocked;

    let renameAcquiredWorkspaceLock = false;
    const renameResult = renameChannel(channelId, "Denied Rename", admin.user.id, {
      afterWorkspaceLocked: async () => {
        renameAcquiredWorkspaceLock = true;
      },
    }).then(
      () => ({ status: "fulfilled" as const }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );
    await Bun.sleep(100);
    expect(renameAcquiredWorkspaceLock).toBe(false);
    releaseDemotion();
    await demoting;
    const deniedRename = await renameResult;
    expect(renameAcquiredWorkspaceLock).toBe(true);
    expect(deniedRename.status).toBe("rejected");
    if (deniedRename.status === "rejected") {
      expect(deniedRename.error).toMatchObject({ status: 403 });
    }

    await updateMemberRole(workspaceId, owner.user.id, admin.user.id, "admin");
    let releaseRename!: () => void;
    const renameGate = new Promise<void>((resolve) => {
      releaseRename = resolve;
    });
    let resolveRenameLocked!: () => void;
    const renameLocked = new Promise<void>((resolve) => {
      resolveRenameLocked = resolve;
    });
    const renaming = renameChannel(channelId, "Allowed Rename", admin.user.id, {
      afterWorkspaceLocked: async () => {
        resolveRenameLocked();
        await renameGate;
      },
    });
    await renameLocked;

    let demotionAcquiredWorkspaceLock = false;
    const secondDemotion = updateMemberRole(
      workspaceId,
      owner.user.id,
      admin.user.id,
      "member",
      {
        afterWorkspaceLocked: async () => {
          demotionAcquiredWorkspaceLock = true;
        },
      },
    );
    await Bun.sleep(100);
    expect(demotionAcquiredWorkspaceLock).toBe(false);
    releaseRename();
    const renamed = await renaming;
    await secondDemotion;
    expect(renamed.name).toBe("allowed-rename");
    expect(demotionAcquiredWorkspaceLock).toBe(true);
  });

  test("delete blocks pending bot-targeted message events", async () => {
    const owner = await registerUser("Pending Outbox Owner");
    const workspaceId = await createWorkspace(
      owner.token,
      `Pending Outbox ${crypto.randomUUID()}`,
    );
    const bot = await createHermesBot(owner.user.id);
    const created = await req(
      "POST",
      "/conversations/channel",
      { workspaceId, name: "Pending Bot Work" },
      owner.token,
    );
    expect(created.status).toBe(200);

    const event = createChatMessageSentV1({
      messageId: crypto.randomUUID(),
      conversationId: created.body.id,
      targetBotIds: [bot.id],
      messageKind: "user",
      automationDepth: 0,
      senderId: owner.user.id,
      senderType: "human",
      workspaceId,
    });
    await enqueueDomainEvent(db, event, { partitionKey: created.body.id });

    expect(
      await req(
        "DELETE",
        `/conversations/channel/${created.body.id}`,
        undefined,
        owner.token,
      ),
    ).toMatchObject({
      status: 409,
      body: {
        error: "Wait for active bot runs to finish before deleting this channel",
      },
    });

    await db
      .update(eventOutbox)
      .set({ deadAt: new Date() })
      .where(eq(eventOutbox.id, event.id));
    expect(
      (
        await req(
          "DELETE",
          `/conversations/channel/${created.body.id}`,
          undefined,
          owner.token,
        )
      ).status,
    ).toBe(200);
    await db.delete(eventOutbox).where(eq(eventOutbox.id, event.id));
  });

  test("delete blocks queued and in-flight Hermes executions until completion", async () => {
    const owner = await registerUser("Active Invocation Owner");
    const workspaceId = await createWorkspace(
      owner.token,
      `Active Invocations ${crypto.randomUUID()}`,
    );
    const bot = await createHermesBot(owner.user.id);
    const cases = [
      {
        label: "queued",
        status: "queued" as const,
        requestJson: { platform: "thechat" },
        startedAt: null,
        completedAt: null,
      },
      {
        label: "polling claimed",
        status: "claimed" as const,
        requestJson: { platform: "thechat", deliveryMode: "polling" },
        startedAt: new Date(),
        completedAt: new Date(),
      },
      {
        label: "webhook in flight",
        status: "running" as const,
        requestJson: { platform: "thechat", deliveryMode: "webhook" },
        startedAt: new Date(),
        completedAt: null,
      },
      {
        label: "webhook delivered without execution completion",
        status: "claimed" as const,
        requestJson: { platform: "thechat", deliveryMode: "webhook" },
        startedAt: new Date(),
        completedAt: new Date(),
      },
    ];

    for (const invocationCase of cases) {
      const created = await req(
        "POST",
        "/conversations/channel",
        { workspaceId, name: invocationCase.label },
        owner.token,
      );
      expect(created.status).toBe(200);
      const message = await req(
        "POST",
        `/messages/${created.body.id}`,
        { content: `Trigger ${invocationCase.label}` },
        owner.token,
      );
      expect(message.status).toBe(200);
      const [invocation] = await db
        .insert(botInvocations)
        .values({
          botId: bot.id,
          conversationId: created.body.id,
          triggerMessageId: message.body.id,
          adapterKind: "hermes",
          status: invocationCase.status,
          requestJson: invocationCase.requestJson,
          responseJson: null,
          startedAt: invocationCase.startedAt,
          completedAt: invocationCase.completedAt,
        })
        .returning({ id: botInvocations.id });

      const blocked = await req(
        "DELETE",
        `/conversations/channel/${created.body.id}`,
        undefined,
        owner.token,
      );
      expect(blocked).toMatchObject({
        status: 409,
        body: {
          error: "Wait for active bot runs to finish before deleting this channel",
        },
      });

      await db
        .update(botInvocations)
        .set({
          status: "claimed",
          responseJson: { completion: { type: "silent" } },
          completedAt: new Date(),
        })
        .where(eq(botInvocations.id, invocation.id));
      expect(
        (
          await req(
            "DELETE",
            `/conversations/channel/${created.body.id}`,
            undefined,
            owner.token,
          )
        ).status,
      ).toBe(200);
    }
  });

  test("delete ignores stale queued Hermes dispatches without pre-authorization mutation", async () => {
    const owner = await registerUser("Stale Invocation Owner");
    const outsider = await registerUser("Stale Invocation Outsider");
    const workspaceId = await createWorkspace(
      owner.token,
      `Stale Invocations ${crypto.randomUUID()}`,
    );
    const bot = await createHermesBot(owner.user.id);
    await addBotToWorkspace(bot.id, workspaceId, owner.user.id);
    const created = await req(
      "POST",
      "/conversations/channel",
      { workspaceId, name: "Stale Run" },
      owner.token,
    );
    const message = await req(
      "POST",
      `/messages/${created.body.id}`,
      { content: "Stale trigger" },
      owner.token,
    );
    expect(created.status).toBe(200);
    expect(message.status).toBe(200);
    const [invocation] = await db
      .insert(botInvocations)
      .values({
        botId: bot.id,
        conversationId: created.body.id,
        triggerMessageId: message.body.id,
        adapterKind: "hermes",
        status: "queued",
        requestJson: { platform: "thechat" },
        responseJson: { status: "dispatch_pending" },
        createdAt: new Date(Date.now() - 10 * 60 * 1000),
      })
      .returning({ id: botInvocations.id });

    expect(
      (
        await req(
          "DELETE",
          `/conversations/channel/${created.body.id}`,
          undefined,
          outsider.token,
        )
      ).status,
    ).toBe(403);
    expect(
      await db
        .select({ status: botInvocations.status })
        .from(botInvocations)
        .where(eq(botInvocations.id, invocation.id)),
    ).toEqual([{ status: "queued" }]);
    expect(
      await db
        .select({ id: messages.id })
        .from(messages)
        .where(
          and(
            eq(messages.conversationId, created.body.id),
            eq(messages.senderId, bot.userId),
          ),
        ),
    ).toHaveLength(0);

    const [, authorizedDelete] = await Promise.race([
      Promise.all([
        failTimedOutHermesDispatchesForConversation(created.body.id),
        req(
          "DELETE",
          `/conversations/channel/${created.body.id}`,
          undefined,
          owner.token,
        ),
      ]),
      new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new Error("stale cleanup/delete deadlocked")),
          2_000,
        );
      }),
    ]);
    expect(authorizedDelete.status).toBe(200);
    await db
      .delete(eventOutbox)
      .where(eq(eventOutbox.partitionKey, created.body.id));
  });

  test("delete refuses channels with attachment lifecycle records", async () => {
    const owner = await registerUser("Attachment Owner");
    const workspaceId = await createWorkspace(
      owner.token,
      `Attachment Protected ${crypto.randomUUID()}`,
    );
    const created = await req(
      "POST",
      "/conversations/channel",
      { workspaceId, name: "Assets" },
      owner.token,
    );
    expect(created.status).toBe(200);

    const now = Date.now();
    await db.insert(attachments).values({
      conversationId: created.body.id,
      uploaderId: owner.user.id,
      fileName: "protected.txt",
      declaredMediaType: "text/plain",
      declaredSizeBytes: 1,
      declaredChecksumSha256: "0".repeat(64),
      quarantineKey: `quarantine/${crypto.randomUUID()}`,
      cleanKey: `clean/${crypto.randomUUID()}`,
      uploadExpiresAt: new Date(now + 60_000),
      expiresAt: new Date(now + 120_000),
    });

    const deleted = await req(
      "DELETE",
      `/conversations/channel/${created.body.id}`,
      undefined,
      owner.token,
    );
    expect(deleted).toMatchObject({
      status: 409,
      body: { error: "Channels with attachments cannot be deleted" },
    });

    const detail = await req(
      "GET",
      `/workspaces/${workspaceId}`,
      undefined,
      owner.token,
    );
    expect(detail.body.channels).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: created.body.id })]),
    );
  });

  test("channel mutations require authentication", async () => {
    const channelId = crypto.randomUUID();
    expect(
      (
        await req("PATCH", `/conversations/channel/${channelId}`, {
          name: "Nope",
        })
      ).status,
    ).toBe(401);
    expect(
      (await req("DELETE", `/conversations/channel/${channelId}`)).status,
    ).toBe(401);
  });
});
