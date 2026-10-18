import { withDatabaseContext, withWorkerDatabaseContext } from '../db/index';
import { asFixtureBot, joinFixtureWorkspace } from '../test-context';
import { afterEach, expect, test } from "bun:test";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db/testing";
import {
  users,
  bots,
  workspaces,
  workspaceMembers,
  conversations,
  conversationParticipants,
} from "../db/schema";
import {
  createWorkspace,
  joinWorkspace,
  removeMember,
  updateMemberRole,
  getWorkspaceDetail,
} from "./workspaces";
import {
  createOrGetDm,
  getConversationDetail,
  requireConversationParticipant,
  listConversationThreads,
} from "./conversations";
import {
  getMessages,
  getMessageByIdForParticipant,
  sendMessage,
  canUserAccessAttachments,
} from "./messages";
import { attachments, messageAttachments } from "../db/schema";

test("single-message reads cannot bypass the installation attachment grant", async () => {
  const f = await botFixture();
  const message = await withDatabaseContext({actorId:f.owner.id,scope:'actor'}, () => sendMessage(
    f.channel.id,
    f.owner.id,
    f.owner.name,
    "Synthetic file message",
  ));
  const [attachment] = await db
    .insert(attachments)
    .values({
      conversationId: f.channel.id,
      uploaderId: f.owner.id,
      fileName: "synthetic.txt",
      declaredMediaType: "text/plain",
      declaredSizeBytes: 1,
      declaredChecksumSha256: "a".repeat(64),
      verifiedMediaType: "text/plain",
      verifiedSizeBytes: 1,
      status: "attached",
      quarantineKey: `synthetic/${crypto.randomUUID()}`,
      cleanKey: `synthetic-clean/${crypto.randomUUID()}`,
      cleanVersionId: "synthetic-version",
      uploadExpiresAt: new Date(),
      expiresAt: new Date(),
      attachedAt: new Date(),
    })
    .returning();
  await db.insert(messageAttachments).values({
    messageId: message.id,
    attachmentId: attachment.id,
    position: 0,
  });
  await withDatabaseContext({actorId:f.owner.id,scope:'actor'}, () => installationService.updateBotInstallation(
    f.workspace.id,
    f.bot.id,
    f.owner.id,
    {
      enabled: true,
      channelScope: "all",
      conversationIds: [],
      attachmentAccess: false,
      sharedRuntimeConsent: true,
      expectedRevision: 1,
    },
  ));
  expect(
    (await withDatabaseContext({actorId:f.botUser.id,scope:'actor'}, () => getMessageByIdForParticipant(message.id, f.botUser.id))).attachments,
  ).toEqual([]);
  expect(
    (await withDatabaseContext({actorId:f.owner.id,scope:'actor'}, () => getMessageByIdForParticipant(message.id, f.owner.id))).attachments,
  ).toHaveLength(1);
});
import {
  listConversationBotRuntime,
  publishHermesPlatformMessage,
} from "./bot-runtime";
import * as installationService from "./bot-installation-access";
import {
  addOwnedBotToWorkspace,
  requestBotForWorkspace,
  acceptBotWorkspaceInvite,
} from "./bot-workspace-memberships";
import { removeBotFromWorkspace } from "./bots";

test("bot invite and removal commit durable invalidations from shared services", async () => {
  const f = await botFixture();
  const second = await withDatabaseContext({actorId:f.member.id,scope:'actor'}, () => createWorkspace("Second bot approval", f.member.id));
  workspaceIds.push(second.id);
  const request = await withDatabaseContext({actorId:f.member.id,scope:'actor'}, () => requestBotForWorkspace(
    second.id,
    f.bot.id,
    f.member.id,
  ));
  expect(request.status).toBe("pending");
  let rows = await db
    .select()
    .from(eventOutbox)
    .where(
      and(
        eq(eventOutbox.tenantId, second.id),
        eq(eventOutbox.eventType, "workspace.lifecycle.notification"),
      ),
    );
  expect(
    rows.some(
      (r) =>
        (r.event.payload.event as any)?.type ===
        "bot_workspace_invite_received",
    ),
  ).toBe(true);
  if (request.status !== "pending")
    throw new Error("expected pending approval");
  await withDatabaseContext({actorId:f.owner.id,scope:'actor'}, () => acceptBotWorkspaceInvite(request.invite.id, f.owner.id));
  const grant = await withDatabaseContext({actorId:f.member.id,scope:'actor'}, () => installationService.getBotInstallation(
    second.id,
    f.bot.id,
    f.member.id,
  ));
  expect(grant.approvedById).toBe(f.member.id);
  expect(
    (
      await withDatabaseContext({actorId:f.owner.id,scope:'actor'}, () => installationService
        .getBotInstallation(second.id, f.bot.id, f.owner.id))
        .then(
          () => null,
          (e) => e,
        )
    )?.status,
  ).toBe(403);
  await withDatabaseContext({actorId:f.member.id,scope:'actor'}, () => removeBotFromWorkspace(f.bot.id, second.id, f.member.id));
  rows = await db
    .select()
    .from(eventOutbox)
    .where(
      and(
        eq(eventOutbox.tenantId, second.id),
        eq(eventOutbox.eventType, "workspace.lifecycle.notification"),
      ),
    );
  expect(
    rows.some(
      (r) =>
        (r.event.payload.event as any)?.type ===
        "bot_workspace_invite_resolved",
    ),
  ).toBe(true);
  expect(
    rows.some((r) => (r.event.payload.event as any)?.type === "member_removed"),
  ).toBe(true);
});
import {
  updateAuthenticatedBotWebhook,
  createHermesBotInWorkspace,
} from "./bots";

test("direct Hermes bootstrap stages its bot membership notification atomically", async () => {
  const f = await fixture();
  const bot = await withDatabaseContext({actorId:f.owner.id,scope:'actor'}, () => createHermesBotInWorkspace(
    "Atomic Hermes",
    null,
    f.owner.id,
    f.workspace.id,
  ));
  userIds.push(bot.userId);
  const rows = await db
    .select()
    .from(eventOutbox)
    .where(
      and(
        eq(eventOutbox.tenantId, f.workspace.id),
        eq(eventOutbox.eventType, "workspace.lifecycle.notification"),
      ),
    );
  expect(
    rows.some(
      (r) =>
        (r.event.payload.event as any)?.type === "member_joined" &&
        (r.event.payload.event as any)?.member?.userId === bot.userId,
    ),
  ).toBe(true);
});

async function botFixture() {
  const f = await fixture();
  const [botUser] = await db
    .insert(users)
    .values({ name: "Synthetic grant bot", type: "bot" })
    .returning();
  userIds.push(botUser.id);
  const [bot] = await db
    .insert(bots)
    .values({
      userId: botUser.id,
      ownerId: f.owner.id,
      kind: "webhook",
      webhookUrl: "https://synthetic.example.test/first",
      webhookSecret: "synthetic-secret",
    })
    .returning();
  await withDatabaseContext({actorId:f.owner.id,scope:'actor'}, () => addOwnedBotToWorkspace(bot.id, f.workspace.id, f.owner.id));
  const [channel] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.workspaceId, f.workspace.id));
  return { ...f, botUser, bot, channel };
}

test("admin-selected installation scopes, attachment ceiling and endpoint consent are workspace-specific", async () => {
  const f = await botFixture();
  const update = (workspaceId:string, botId:string, actorId:string, input:any) => withDatabaseContext({actorId,scope:"actor"},()=>installationService.updateBotInstallation(workspaceId,botId,actorId,input));
  expect(typeof update).toBe("function");
  const grant = await update(f.workspace.id, f.bot.id, f.owner.id, {
    enabled: true,
    channelScope: "selected",
    conversationIds: [f.channel.id],
    attachmentAccess: false,
    sharedRuntimeConsent: true,
    approveEndpoint: true,
    expectedRevision: 1,
  });
  expect(grant.revision).toBe(2);
  await withDatabaseContext({actorId:f.botUser.id,scope:'actor'}, () => requireConversationParticipant(f.channel.id, f.botUser.id));
  expect(
    (
      await update(f.workspace.id, f.bot.id, f.botUser.id, {
        ...grant,
        expectedRevision: 2,
      }).then(
        () => null,
        (e: any) => e,
      )
    )?.status,
  ).toBe(403);
  expect(
    (
      await update(f.workspace.id, f.bot.id, f.member.id, {
        ...grant,
        expectedRevision: 2,
      }).then(
        () => null,
        (e: any) => e,
      )
    )?.status,
  ).toBe(403);
  const [denied] = await db
    .insert(conversations)
    .values({ type: "group", workspaceId: f.workspace.id, name: "denied" })
    .returning();
  await db
    .insert(conversationParticipants)
    .values({ conversationId: denied.id, userId: f.botUser.id });
  expect(
    (
      await withDatabaseContext({actorId:f.botUser.id,scope:'actor'}, () => requireConversationParticipant(denied.id, f.botUser.id)).then(
        () => null,
        (e) => e,
      )
    )?.status,
  ).toBe(403);
  await withDatabaseContext({actorId:f.botUser.id,scope:'actor'}, () => updateAuthenticatedBotWebhook(
    f.botUser.id,
    "https://synthetic.example.test/second",
  ));
  expect(
    (
      await withDatabaseContext({actorId:f.botUser.id,scope:'actor'}, () => installationService
        .requireBotInstallationAccess(db, f.channel.id, f.botUser.id, {
          endpoint: true,
        }))
        .then(
          () => null,
          (e) => e,
        )
    )?.status,
  ).toBe(403);
  await update(f.workspace.id, f.bot.id, f.owner.id, {
    enabled: true,
    channelScope: "all",
    conversationIds: [],
    attachmentAccess: false,
    sharedRuntimeConsent: true,
    approveEndpoint: true,
    expectedRevision: 2,
  });
  await withDatabaseContext({actorId:f.botUser.id,scope:'actor'}, () => requireConversationParticipant(f.channel.id, f.botUser.id));
  expect(
    (
      await update(f.workspace.id, f.bot.id, f.owner.id, {
        enabled: true,
        channelScope: "all",
        conversationIds: [],
        attachmentAccess: true,
        sharedRuntimeConsent: true,
        expectedRevision: 2,
      }).then(
        () => null,
        (e: any) => e,
      )
    )?.status,
  ).toBe(409);
});

test("attachment permission is installation grant intersected with global safety", async () => {
  const f = await botFixture();
  await withDatabaseContext({actorId:f.owner.id,scope:'actor'}, () => installationService.updateBotInstallation(
    f.workspace.id,
    f.bot.id,
    f.owner.id,
    {
      enabled: true,
      channelScope: "all",
      conversationIds: [],
      attachmentAccess: false,
      sharedRuntimeConsent: true,
      expectedRevision: 1,
    },
  ));
  expect(
    await withDatabaseContext({actorId:f.botUser.id,scope:'actor'}, () => (canUserAccessAttachments as any)(db, f.botUser.id, f.channel.id)),
  ).toBe(false);
  await withDatabaseContext({actorId:f.owner.id,scope:'actor'}, () => installationService.updateBotInstallation(
    f.workspace.id,
    f.bot.id,
    f.owner.id,
    {
      enabled: true,
      channelScope: "all",
      conversationIds: [],
      attachmentAccess: true,
      sharedRuntimeConsent: true,
      expectedRevision: 2,
    },
  ));
  expect(
    await withDatabaseContext({actorId:f.botUser.id,scope:'actor'}, () => (canUserAccessAttachments as any)(db, f.botUser.id, f.channel.id)),
  ).toBe(true);
  await db
    .update(bots)
    .set({ attachmentAccess: false })
    .where(eq(bots.id, f.bot.id));
  expect(
    await withDatabaseContext({actorId:f.botUser.id,scope:'actor'}, () => (canUserAccessAttachments as any)(db, f.botUser.id, f.channel.id)),
  ).toBe(false);
});

import { createInvite, acceptInvite, declineInvite } from "./invites";
import { eventOutbox, workspaceInvites } from "../db/schema";

test("workspace bootstrap rolls back owner and General on injected post-owner failure", async () => {
  const { owner } = await fixture();
  const name = `rollback-${crypto.randomUUID()}`;
  const error = await withDatabaseContext({actorId:owner.id,scope:'actor'}, () => (createWorkspace as any)(name, owner.id, {
    afterOwnerInserted: async () => {
      throw new Error("synthetic bootstrap failure");
    },
  })).then(
    (w: any) => {
      workspaceIds.push(w.id);
      return null;
    },
    (e: any) => e,
  );
  expect(error?.message).toBe("synthetic bootstrap failure");
  expect(
    await db.select().from(workspaces).where(eq(workspaces.name, name)),
  ).toHaveLength(0);
});

test("invite enrollment rollback retains pending state without membership or lifecycle effects", async () => {
  const f = await fixture();
  const [invitee] = await db
    .insert(users)
    .values({
      name: "Rollback invitee",
      email: `rollback-invite-${crypto.randomUUID()}@example.test`,
    })
    .returning();
  userIds.push(invitee.id);
  const invite = await withDatabaseContext({actorId:f.owner.id,scope:'actor'}, () => createInvite(f.workspace.id, f.owner.id, invitee.email!));
  const outcome = await withDatabaseContext({actorId:invitee.id,scope:'actor'}, () => acceptInvite(invite.id, invitee.id, {
    afterEnrollment: async () => {
      throw new Error("synthetic enrollment rollback");
    },
  })).then(
    () => null,
    (error) => error,
  );
  expect(outcome?.message).toBe("synthetic enrollment rollback");
  const [saved] = await db
    .select()
    .from(workspaceInvites)
    .where(eq(workspaceInvites.id, invite.id));
  expect(saved.status).toBe("pending");
  expect(
    await db
      .select()
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, f.workspace.id),
          eq(workspaceMembers.userId, invitee.id),
        ),
      ),
  ).toHaveLength(0);
  expect(
    await db
      .select()
      .from(conversationParticipants)
      .where(eq(conversationParticipants.userId, invitee.id)),
  ).toHaveLength(0);
  const rows = await db
    .select()
    .from(eventOutbox)
    .where(eq(eventOutbox.tenantId, f.workspace.id));
  expect(
    rows.filter(
      (r) =>
        (r.event.payload.event as any)?.type === "member_joined" &&
        (r.event.payload.event as any)?.member?.userId === invitee.id,
    ),
  ).toHaveLength(0);
});

test("concurrent invitation acceptances consume once and emit one durable enrollment", async () => {
  const f = await fixture();
  const [invitee] = await db
    .insert(users)
    .values({
      name: "Concurrent invitee",
      email: `concurrent-invite-${crypto.randomUUID()}@example.test`,
    })
    .returning();
  userIds.push(invitee.id);
  const invite = await withDatabaseContext({actorId:f.owner.id,scope:'actor'}, () => createInvite(f.workspace.id, f.owner.id, invitee.email!));
  const outcomes = await Promise.allSettled([
    withDatabaseContext({actorId:invitee.id,scope:'actor'}, () => acceptInvite(invite.id, invitee.id)),
    withDatabaseContext({actorId:invitee.id,scope:'actor'}, () => acceptInvite(invite.id, invitee.id)),
  ]);
  expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
  expect(outcomes.filter((o) => o.status === "rejected")).toHaveLength(1);
  expect(
    await db
      .select()
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, f.workspace.id),
          eq(workspaceMembers.userId, invitee.id),
        ),
      ),
  ).toHaveLength(1);
  const rows = await db
    .select()
    .from(eventOutbox)
    .where(eq(eventOutbox.tenantId, f.workspace.id));
  expect(
    rows.filter(
      (r) =>
        (r.event.payload.event as any)?.type === "member_joined" &&
        (r.event.payload.event as any)?.member?.userId === invitee.id,
    ),
  ).toHaveLength(1);
});

test("outstanding invite cannot enroll after inviter loses authority", async () => {
  const f = await fixture();
  await db
    .update(workspaceMembers)
    .set({ role: "admin" })
    .where(
      and(
        eq(workspaceMembers.workspaceId, f.workspace.id),
        eq(workspaceMembers.userId, f.member.id),
      ),
    );
  const [invitee] = await db
    .insert(users)
    .values({
      name: "Invitee",
      email: `invitee-${crypto.randomUUID()}@example.test`,
    })
    .returning();
  userIds.push(invitee.id);
  const invite = await withDatabaseContext({actorId:f.member.id,scope:'actor'}, () => createInvite(
    f.workspace.id,
    f.member.id,
    invitee.email!,
  ));
  await withDatabaseContext({actorId:f.owner.id,scope:'actor'}, () => removeMember(f.workspace.id, f.owner.id, f.member.id));
  expect(
    (
      await withDatabaseContext({actorId:invitee.id,scope:'actor'}, () => acceptInvite(invite.id, invitee.id)).then(
        () => null,
        (e) => e,
      )
    )?.status,
  ).toBe(403);
  expect(
    await db
      .select()
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, f.workspace.id),
          eq(workspaceMembers.userId, invitee.id),
        ),
      ),
  ).toHaveLength(0);
  const [saved] = await db
    .select()
    .from(workspaceInvites)
    .where(eq(workspaceInvites.id, invite.id));
  expect(saved.status).toBe("pending");
});

test("membership mutations persist lifecycle notifications in their own transaction", async () => {
  const f = await fixture();
  await withDatabaseContext({actorId:f.owner.id,scope:'actor'}, () => updateMemberRole(f.workspace.id, f.owner.id, f.member.id, "admin"));
  const notifications = await db
    .select()
    .from(eventOutbox)
    .where(
      and(
        eq(eventOutbox.tenantId, f.workspace.id),
        eq(eventOutbox.eventType, "workspace.lifecycle.notification"),
      ),
    );
  const event = notifications.find(
    (n) => (n.event.payload.event as any)?.type === "member_role_changed",
  );
  expect(event).toBeDefined();
  expect(event!.event.payload).toMatchObject({
    targetUserIds: expect.arrayContaining([f.owner.id, f.member.id]),
    event: {
      type: "member_role_changed",
      workspaceId: f.workspace.id,
      userId: f.member.id,
      newRole: "admin",
    },
  });
});

test("installation attachment denial fences normal sends before attachment binding", async () => {
  const f = await botFixture();
  await withDatabaseContext({actorId:f.owner.id,scope:'actor'}, () => installationService.updateBotInstallation(
    f.workspace.id,
    f.bot.id,
    f.owner.id,
    {
      enabled: true,
      channelScope: "all",
      conversationIds: [],
      attachmentAccess: false,
      sharedRuntimeConsent: true,
      expectedRevision: 1,
    },
  ));
  expect(
    (
      await withDatabaseContext({actorId:f.botUser.id,scope:'actor'}, () => sendMessage(f.channel.id, f.botUser.id, f.botUser.name, "file", {
        attachmentIds: [crypto.randomUUID()],
      })).then(
        () => null,
        (e) => e,
      )
    )?.status,
  ).toBe(403);
});

test("installation attachment denial fences Hermes response uploads", async () => {
  const f = await botFixture();
  await db.update(bots).set({ kind: "hermes" }).where(eq(bots.id, f.bot.id));
  await withDatabaseContext({actorId:f.owner.id,scope:'actor'}, () => installationService.updateBotInstallation(
    f.workspace.id,
    f.bot.id,
    f.owner.id,
    {
      enabled: true,
      channelScope: "all",
      conversationIds: [],
      attachmentAccess: false,
      sharedRuntimeConsent: true,
      expectedRevision: 1,
    },
  ));
  expect(
    (
      await asFixtureBot(({
        authenticatedBotId: f.bot.id,
        conversationId: f.channel.id,
        content: "file",
        attachmentIds: [crypto.randomUUID()],
      }).authenticatedBotId, () => publishHermesPlatformMessage({
        authenticatedBotId: f.bot.id,
        conversationId: f.channel.id,
        content: "file",
        attachmentIds: [crypto.randomUUID()],
      })).then(
        () => null,
        (e) => e,
      )
    )?.status,
  ).toBe(403);
});

test("bot membership approval persists the same durable member lifecycle contract", async () => {
  const f = await botFixture();
  const rows = await db
    .select()
    .from(eventOutbox)
    .where(
      and(
        eq(eventOutbox.tenantId, f.workspace.id),
        eq(eventOutbox.eventType, "workspace.lifecycle.notification"),
      ),
    );
  expect(
    rows.some(
      (r) =>
        (r.event.payload.event as any)?.type === "member_joined" &&
        (r.event.payload.event as any)?.member?.userId === f.botUser.id,
    ),
  ).toBe(true);
});

import { resolveMessageBotTargetIds } from "./message-bot-targets";

test("mentions and runtime reads obey the installation channel scope", async () => {
  const f = await botFixture();
  await withDatabaseContext({actorId:f.owner.id,scope:'actor'}, () => installationService.updateBotInstallation(
    f.workspace.id,
    f.bot.id,
    f.owner.id,
    {
      enabled: true,
      channelScope: "selected",
      conversationIds: [],
      attachmentAccess: false,
      sharedRuntimeConsent: true,
      expectedRevision: 1,
    },
  ));
  expect(
    await resolveMessageBotTargetIds(db, {
      conversationId: f.channel.id,
      content: `@${f.botUser.name} task`,
      senderId: f.owner.id,
      senderType: "human",
    }),
  ).toEqual([]);
  expect(
    (
      await withDatabaseContext({actorId:f.botUser.id,scope:'actor'}, () => listConversationBotRuntime(f.channel.id, f.botUser.id)).then(
        () => null,
        (e) => e,
      )
    )?.status,
  ).toBe(403);
});

test("workspace channel discovery honors bot scope without privatizing human channels", async () => {
  const f = await botFixture();
  await withDatabaseContext({actorId:f.owner.id,scope:'actor'}, () => installationService.updateBotInstallation(
    f.workspace.id,
    f.bot.id,
    f.owner.id,
    {
      enabled: true,
      channelScope: "selected",
      conversationIds: [],
      attachmentAccess: false,
      sharedRuntimeConsent: true,
      expectedRevision: 1,
    },
  ));
  expect(
    (await withDatabaseContext({actorId:f.botUser.id,scope:'actor'}, () => getWorkspaceDetail(f.workspace.id, f.botUser.id))).channels,
  ).toEqual([]);
  expect(
    (await withDatabaseContext({actorId:f.member.id,scope:'actor'}, () => getWorkspaceDetail(f.workspace.id, f.member.id))).channels.map(
      (c) => c.id,
    ),
  ).toContain(f.channel.id);
});

import { withAuthorizedRealtimeEvent } from "../ws/resource-authorization";

test("workspace realtime roster events also require a live bot installation grant", async () => {
  const f = await botFixture();
  await withDatabaseContext({actorId:f.owner.id,scope:'actor'}, () => installationService.updateBotInstallation(
    f.workspace.id,
    f.bot.id,
    f.owner.id,
    {
      enabled: false,
      channelScope: "all",
      conversationIds: [],
      attachmentAccess: false,
      sharedRuntimeConsent: true,
      expectedRevision: 1,
    },
  ));
  let delivered = 0;
  await withDatabaseContext({actorId:f.botUser.id,scope:'actor'}, () => withAuthorizedRealtimeEvent(
    f.botUser.id,
    {
      type: "member_role_changed",
      workspaceId: f.workspace.id,
      userId: f.member.id,
      newRole: "admin",
    },
    () => {
      delivered++;
    },
  ));
  expect(delivered).toBe(0);
  await withDatabaseContext({actorId:f.botUser.id,scope:'actor'}, () => withAuthorizedRealtimeEvent(
    f.botUser.id,
    { type: "presence_changed", userId: f.owner.id, online: true },
    () => {
      delivered++;
    },
  ));
  expect(delivered).toBe(0);
});

test("a bot credential cannot administer installation requests even with an admin membership row", async () => {
  const f = await botFixture();
  await db
    .update(workspaceMembers)
    .set({ role: "admin" })
    .where(
      and(
        eq(workspaceMembers.workspaceId, f.workspace.id),
        eq(workspaceMembers.userId, f.botUser.id),
      ),
    );
  expect(
    (
      await withDatabaseContext({actorId:f.botUser.id,scope:'actor'}, () => requestBotForWorkspace(f.workspace.id, f.bot.id, f.botUser.id)).then(
        () => null,
        (e) => e,
      )
    )?.status,
  ).toBe(403);
});

test("a bot credential cannot bootstrap another workspace installation even with an admin membership row", async () => {
  const f = await botFixture();
  await db
    .update(workspaceMembers)
    .set({ role: "admin" })
    .where(
      and(
        eq(workspaceMembers.workspaceId, f.workspace.id),
        eq(workspaceMembers.userId, f.botUser.id),
      ),
    );
  const outcome = await withDatabaseContext({actorId:f.botUser.id,scope:'actor'}, () => createHermesBotInWorkspace(
    "denied bot bootstrap",
    null,
    f.botUser.id,
    f.workspace.id,
  )).then(
    () => null,
    (e) => e,
  );
  expect(outcome?.status).toBe(403);
});

test("a captured bot approval notification drops after requester demotion", async () => {
  const f = await botFixture();
  const second = await withDatabaseContext({actorId:f.owner.id,scope:'actor'}, () => createWorkspace("Captured bot invite", f.owner.id));
  workspaceIds.push(second.id);
  await withDatabaseContext({actorId:f.member.id,scope:'actor'}, () => joinFixtureWorkspace(second.id, f.member.id));
  await withDatabaseContext({actorId:f.owner.id,scope:'actor'}, () => updateMemberRole(second.id, f.owner.id, f.member.id, "admin"));
  const result = await withDatabaseContext({actorId:f.member.id,scope:'actor'}, () => requestBotForWorkspace(second.id, f.bot.id, f.member.id));
  if (result.status !== "pending") throw new Error("expected pending invite");
  await withDatabaseContext({actorId:f.owner.id,scope:'actor'}, () => updateMemberRole(second.id, f.owner.id, f.member.id, "member"));
  let delivered = 0;
  await withDatabaseContext({actorId:f.owner.id,scope:'actor'}, () => withAuthorizedRealtimeEvent(
    f.owner.id,
    { type: "bot_workspace_invite_received", invite: result.invite },
    () => {
      delivered++;
    },
  ));
  expect(delivered).toBe(0);
});

const userIds: string[] = [];
const workspaceIds: string[] = [];
const personalIds: string[] = [];
afterEach(async () => {
  if (personalIds.length)
    await db
      .delete(conversations)
      .where(inArray(conversations.id, personalIds.splice(0)));
  if (workspaceIds.length)
    await db
      .delete(workspaces)
      .where(inArray(workspaces.id, workspaceIds.splice(0)));
  if (userIds.length)
    await db.delete(users).where(inArray(users.id, userIds.splice(0)));
});
test("bot membership without explicit workspace installation fails closed", async () => {
  const { owner, workspace } = await fixture();
  const [botUser] = await db
    .insert(users)
    .values({ name: "Synthetic bot", type: "bot" })
    .returning();
  userIds.push(botUser.id);
  await db.insert(bots).values({
    userId: botUser.id,
    ownerId: owner.id,
    kind: "webhook",
    webhookUrl: "https://synthetic.example.test/first",
    webhookSecret: "synthetic-secret",
  });
  await withDatabaseContext({actorId:botUser.id,scope:'actor'}, () => joinFixtureWorkspace(workspace.id, botUser.id));
  const [channel] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.workspaceId, workspace.id));
  expect(
    (
      await withDatabaseContext({actorId:botUser.id,scope:'actor'}, () => requireConversationParticipant(channel.id, botUser.id)).then(
        () => null,
        (e) => e,
      )
    )?.status,
  ).toBe(403);
  expect(
    (
      await withDatabaseContext({actorId:botUser.id,scope:'actor'}, () => getMessages(channel.id, botUser.id)).then(
        () => null,
        (e) => e,
      )
    )?.status,
  ).toBe(403);
  expect(
    (
      await withDatabaseContext({actorId:botUser.id,scope:'actor'}, () => sendMessage(channel.id, botUser.id, botUser.name, "denied")).then(
        () => null,
        (e) => e,
      )
    )?.status,
  ).toBe(403);
});

export async function fixture() {
  const [owner, member] = await db
    .insert(users)
    .values([
      {
        name: "Synthetic owner",
        email: `owner-${crypto.randomUUID()}@example.test`,
      },
      {
        name: "Synthetic member",
        email: `member-${crypto.randomUUID()}@example.test`,
      },
    ])
    .returning();
  userIds.push(owner.id, member.id);
  const workspace = await withDatabaseContext({actorId:owner.id,scope:'actor'}, () => createWorkspace(
    `Auth ${crypto.randomUUID()}`,
    owner.id,
  ));
  workspaceIds.push(workspace.id);
  await withDatabaseContext({actorId:member.id,scope:'actor'}, () => joinFixtureWorkspace(workspace.id, member.id));
  return { owner, member, workspace };
}

test("workspace-owned DM denies all shared reads after membership disappears even with stale participation", async () => {
  const { owner, member, workspace } = await fixture();
  const dm = await withDatabaseContext({actorId:owner.id,scope:'actor'}, () => createOrGetDm(workspace.id, owner.id, member.id));
  await db
    .delete(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspace.id),
        eq(workspaceMembers.userId, member.id),
      ),
    );
  for (const read of [
    requireConversationParticipant,
    getConversationDetail,
    getMessages,
    listConversationThreads,
    listConversationBotRuntime,
  ]) {
    const error = await withDatabaseContext<unknown>({actorId:member.id,scope:'actor'}, () => read(dm.id, member.id)).then(
      () => null,
      (e) => e,
    );
    expect(error?.status).toBe(403);
  }
  expect(
    (
      await withDatabaseContext({actorId:member.id,scope:'actor'}, () => sendMessage(dm.id, member.id, member.name, "denied")).then(
        () => null,
        (e) => e,
      )
    )?.status,
  ).toBe(403);
});

test("member removal deletes workspace DM participation but preserves unscoped personal DM access", async () => {
  const { owner, member, workspace } = await fixture();
  const dm = await withDatabaseContext({actorId:owner.id,scope:'actor'}, () => createOrGetDm(workspace.id, owner.id, member.id));
  const [personal] = await db
    .insert(conversations)
    .values({ type: "direct" })
    .returning();
  personalIds.push(personal.id);
  await db.insert(conversationParticipants).values([
    { conversationId: personal.id, userId: member.id },
    { conversationId: personal.id, userId: owner.id },
  ]);
  await withDatabaseContext({actorId:owner.id,scope:'actor'}, () => removeMember(workspace.id, owner.id, member.id));
  const stale = await db
    .select()
    .from(conversationParticipants)
    .where(
      and(
        eq(conversationParticipants.conversationId, dm.id),
        eq(conversationParticipants.userId, member.id),
      ),
    );
  expect(stale).toHaveLength(0);
  await withDatabaseContext({actorId:member.id,scope:'actor'}, () => requireConversationParticipant(personal.id, member.id));
  expect((await withDatabaseContext({actorId:member.id,scope:'actor'}, () => getConversationDetail(personal.id, member.id))).id).toBe(
    personal.id,
  );
});
