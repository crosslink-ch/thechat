import { and, eq } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type {
  BotWorkspaceInvite,
  BotWorkspaceInviteResult,
  BotWorkspaceInviteStatus,
  WorkspaceMember,
  WsServerEvent,
} from "@thechat/shared";
import { db } from "../db";
import {
  bots,
  botWorkspaceInvites,
  conversationParticipants,
  conversations,
  users,
  workspaceMembers,
  workspaces,
} from "../db/schema";
import { broadcastToUser } from "../ws";
import { ServiceError } from "./errors";
import { removeBotFromWorkspace } from "./bots";

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type BotRecord = {
  id: string;
  userId: string;
  ownerId: string;
  name: string;
  kind: "webhook" | "hermes";
};

type InviteRecord = {
  id: string;
  workspaceId: string;
  workspaceName: string;
  botId: string;
  botName: string;
  requesterId: string;
  requesterName: string;
  status: BotWorkspaceInviteStatus;
  createdAt: Date;
};

const botUsers = alias(users, "bot_workspace_invite_bot_users");
const requesterUsers = alias(users, "bot_workspace_invite_requester_users");

function serializeInvite(invite: InviteRecord): BotWorkspaceInvite {
  return {
    id: invite.id,
    workspaceId: invite.workspaceId,
    workspaceName: invite.workspaceName,
    botId: invite.botId,
    botName: invite.botName,
    requesterId: invite.requesterId,
    requesterName: invite.requesterName,
    status: invite.status,
    createdAt: invite.createdAt.toISOString(),
  };
}

async function requireWorkspaceAdmin(
  tx: DbTransaction,
  workspaceId: string,
  userId: string,
) {
  const [membership] = await tx
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, userId),
      ),
    )
    .limit(1);

  if (!membership || !["owner", "admin"].includes(membership.role)) {
    throw new ServiceError(
      "Only workspace admins can manage bots",
      403,
    );
  }

  return membership;
}

async function lockWorkspace(tx: DbTransaction, workspaceId: string) {
  const [workspace] = await tx
    .select({ id: workspaces.id, name: workspaces.name })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .for("update")
    .limit(1);

  if (!workspace) {
    throw new ServiceError("Workspace not found", 404);
  }

  return workspace;
}

async function getBotRecord(tx: DbTransaction, botId: string): Promise<BotRecord> {
  const [bot] = await tx
    .select({
      id: bots.id,
      userId: bots.userId,
      ownerId: bots.ownerId,
      name: users.name,
      kind: bots.kind,
    })
    .from(bots)
    .innerJoin(users, eq(bots.userId, users.id))
    .where(eq(bots.id, botId))
    .limit(1);

  if (!bot) {
    throw new ServiceError("Bot not found", 404);
  }

  return bot;
}

async function getHumanWorkspaceRecipientIds(
  tx: DbTransaction,
  workspaceId: string,
  adminsOnly = false,
) {
  const rows = await tx
    .select({ userId: workspaceMembers.userId, role: workspaceMembers.role })
    .from(workspaceMembers)
    .innerJoin(users, eq(workspaceMembers.userId, users.id))
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(users.type, "human"),
      ),
    );

  return rows
    .filter((row) => !adminsOnly || ["owner", "admin"].includes(row.role))
    .map((row) => row.userId);
}

async function attachBotMembership(
  tx: DbTransaction,
  workspaceId: string,
  bot: BotRecord,
): Promise<{ member: WorkspaceMember; inserted: boolean }> {
  const [insertedMembership] = await tx
    .insert(workspaceMembers)
    .values({
      workspaceId,
      userId: bot.userId,
      role: "member",
    })
    .onConflictDoNothing()
    .returning({ joinedAt: workspaceMembers.joinedAt });

  const channelRows = await tx
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(
        eq(conversations.workspaceId, workspaceId),
        eq(conversations.type, "group"),
        eq(conversations.isPrivate, false),
      ),
    );

  if (channelRows.length > 0) {
    await tx
      .insert(conversationParticipants)
      .values(
        channelRows.map((channel) => ({
          conversationId: channel.id,
          userId: bot.userId,
          role: "member" as const,
        })),
      )
      .onConflictDoNothing();
  }

  let joinedAt = insertedMembership?.joinedAt;
  if (!joinedAt) {
    const [existingMembership] = await tx
      .select({ joinedAt: workspaceMembers.joinedAt })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.userId, bot.userId),
        ),
      )
      .limit(1);
    joinedAt = existingMembership?.joinedAt;
  }

  if (!joinedAt) {
    throw new ServiceError("Could not add bot to workspace", 500);
  }

  return {
    inserted: Boolean(insertedMembership),
    member: {
      userId: bot.userId,
      user: {
        id: bot.userId,
        name: bot.name,
        email: null,
        avatar: null,
        type: "bot",
      },
      bot: { id: bot.id, kind: bot.kind },
      role: "member",
      joinedAt: joinedAt.toISOString(),
    },
  };
}

function broadcastToRecipients(userIds: Iterable<string>, event: WsServerEvent) {
  for (const userId of new Set(userIds)) {
    broadcastToUser(userId, event);
  }
}

function broadcastMemberJoined(
  workspaceId: string,
  member: WorkspaceMember,
  recipientIds: string[],
) {
  broadcastToRecipients(recipientIds, {
    type: "member_joined",
    workspaceId,
    member,
  });
}

function resolvedEvent(
  inviteId: string,
  workspaceId: string,
  botId: string,
  status: Exclude<BotWorkspaceInviteStatus, "pending">,
): WsServerEvent {
  return {
    type: "bot_workspace_invite_resolved",
    inviteId,
    workspaceId,
    botId,
    status,
  };
}

async function resolveOutstandingRequestsForAttachedBot(
  tx: DbTransaction,
  workspaceId: string,
  botId: string,
) {
  return tx
    .update(botWorkspaceInvites)
    .set({ status: "accepted", updatedAt: new Date() })
    .where(
      and(
        eq(botWorkspaceInvites.workspaceId, workspaceId),
        eq(botWorkspaceInvites.botId, botId),
        eq(botWorkspaceInvites.status, "pending"),
      ),
    )
    .returning({
      id: botWorkspaceInvites.id,
      requesterId: botWorkspaceInvites.requesterId,
    });
}

export async function addOwnedBotToWorkspace(
  botId: string,
  workspaceId: string,
  callerId: string,
) {
  const result = await db.transaction(async (tx) => {
    await lockWorkspace(tx, workspaceId);
    await requireWorkspaceAdmin(tx, workspaceId, callerId);
    const bot = await getBotRecord(tx, botId);
    if (bot.ownerId !== callerId) {
      throw new ServiceError(
        "Only the bot owner can add it directly to a workspace",
        403,
      );
    }

    const attachment = await attachBotMembership(tx, workspaceId, bot);
    const recipients = await getHumanWorkspaceRecipientIds(tx, workspaceId);
    const resolved = await resolveOutstandingRequestsForAttachedBot(
      tx,
      workspaceId,
      botId,
    );

    return { bot, attachment, recipients, resolved };
  });

  if (result.attachment.inserted) {
    broadcastMemberJoined(
      workspaceId,
      result.attachment.member,
      result.recipients,
    );
  }
  for (const invite of result.resolved) {
    broadcastToRecipients([...result.recipients, invite.requesterId, result.bot.ownerId],
      resolvedEvent(invite.id, workspaceId, botId, "accepted"),
    );
  }

  return { success: true, botId };
}

export async function requestBotForWorkspace(
  workspaceId: string,
  botId: string,
  requesterId: string,
  options: { afterWorkspaceLocked?: () => Promise<void> } = {},
): Promise<BotWorkspaceInviteResult> {
  const result = await db.transaction(async (tx) => {
    const workspace = await lockWorkspace(tx, workspaceId);
    await options.afterWorkspaceLocked?.();
    await requireWorkspaceAdmin(tx, workspaceId, requesterId);
    const bot = await getBotRecord(tx, botId);

    const [requester] = await tx
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, requesterId))
      .limit(1);
    if (!requester) {
      throw new ServiceError("Requester not found", 404);
    }

    if (bot.ownerId === requesterId) {
      const attachment = await attachBotMembership(tx, workspaceId, bot);
      const recipients = await getHumanWorkspaceRecipientIds(tx, workspaceId);
      const resolved = await resolveOutstandingRequestsForAttachedBot(
        tx,
        workspaceId,
        botId,
      );
      return {
        kind: "added" as const,
        bot,
        attachment,
        recipients,
        resolved,
      };
    }

    const [existingMembership] = await tx
      .select({ userId: workspaceMembers.userId })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.userId, bot.userId),
        ),
      )
      .limit(1);
    if (existingMembership) {
      return { kind: "already_added" as const, bot };
    }

    const [inserted] = await tx
      .insert(botWorkspaceInvites)
      .values({ workspaceId, botId, requesterId })
      .onConflictDoNothing()
      .returning({
        id: botWorkspaceInvites.id,
        status: botWorkspaceInvites.status,
        createdAt: botWorkspaceInvites.createdAt,
      });

    if (!inserted) {
      throw new ServiceError(
        "An approval request for this bot is already pending",
        409,
      );
    }

    const invite = serializeInvite({
      id: inserted.id,
      workspaceId,
      workspaceName: workspace.name,
      botId,
      botName: bot.name,
      requesterId,
      requesterName: requester.name,
      status: inserted.status,
      createdAt: inserted.createdAt,
    });

    return { kind: "pending" as const, bot, invite };
  });

  if (result.kind === "added") {
    if (result.attachment.inserted) {
      broadcastMemberJoined(
        workspaceId,
        result.attachment.member,
        result.recipients,
      );
    }
    for (const invite of result.resolved) {
      broadcastToRecipients(
        [...result.recipients, invite.requesterId, result.bot.ownerId],
        resolvedEvent(invite.id, workspaceId, botId, "accepted"),
      );
    }
    return { status: "added", botId };
  }

  if (result.kind === "already_added") {
    return { status: "added", botId };
  }

  broadcastToUser(result.bot.ownerId, {
    type: "bot_workspace_invite_received",
    invite: result.invite,
  });
  return { status: "pending", invite: result.invite };
}

function pendingInviteSelect() {
  return db
    .select({
      id: botWorkspaceInvites.id,
      workspaceId: botWorkspaceInvites.workspaceId,
      workspaceName: workspaces.name,
      botId: botWorkspaceInvites.botId,
      botName: botUsers.name,
      requesterId: botWorkspaceInvites.requesterId,
      requesterName: requesterUsers.name,
      status: botWorkspaceInvites.status,
      createdAt: botWorkspaceInvites.createdAt,
      ownerId: bots.ownerId,
    })
    .from(botWorkspaceInvites)
    .innerJoin(workspaces, eq(botWorkspaceInvites.workspaceId, workspaces.id))
    .innerJoin(bots, eq(botWorkspaceInvites.botId, bots.id))
    .innerJoin(botUsers, eq(bots.userId, botUsers.id))
    .innerJoin(
      requesterUsers,
      eq(botWorkspaceInvites.requesterId, requesterUsers.id),
    );
}

export async function listWorkspaceBotInvites(
  workspaceId: string,
  callerId: string,
): Promise<BotWorkspaceInvite[]> {
  const [membership] = await db
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, callerId),
      ),
    )
    .limit(1);
  if (!membership || !["owner", "admin"].includes(membership.role)) {
    throw new ServiceError(
      "Only workspace admins can view bot approval requests",
      403,
    );
  }

  const rows = await pendingInviteSelect().where(
    and(
      eq(botWorkspaceInvites.workspaceId, workspaceId),
      eq(botWorkspaceInvites.status, "pending"),
    ),
  );
  return rows.map(serializeInvite);
}

export async function listOwnedPendingBotWorkspaceInvites(
  ownerId: string,
): Promise<BotWorkspaceInvite[]> {
  const rows = await pendingInviteSelect().where(
    and(
      eq(bots.ownerId, ownerId),
      eq(botWorkspaceInvites.status, "pending"),
    ),
  );
  return rows.map(serializeInvite);
}

async function getInviteForResolution(
  tx: DbTransaction,
  inviteId: string,
  ownerId: string,
) {
  const resolutionBotUsers = alias(users, "resolution_bot_users");
  const resolutionRequesterUsers = alias(users, "resolution_requester_users");
  const [invite] = await tx
    .select({
      id: botWorkspaceInvites.id,
      workspaceId: botWorkspaceInvites.workspaceId,
      workspaceName: workspaces.name,
      botId: botWorkspaceInvites.botId,
      botUserId: bots.userId,
      botOwnerId: bots.ownerId,
      botName: resolutionBotUsers.name,
      botKind: bots.kind,
      requesterId: botWorkspaceInvites.requesterId,
      requesterName: resolutionRequesterUsers.name,
      status: botWorkspaceInvites.status,
      createdAt: botWorkspaceInvites.createdAt,
    })
    .from(botWorkspaceInvites)
    .innerJoin(workspaces, eq(botWorkspaceInvites.workspaceId, workspaces.id))
    .innerJoin(bots, eq(botWorkspaceInvites.botId, bots.id))
    .innerJoin(resolutionBotUsers, eq(bots.userId, resolutionBotUsers.id))
    .innerJoin(
      resolutionRequesterUsers,
      eq(botWorkspaceInvites.requesterId, resolutionRequesterUsers.id),
    )
    .where(eq(botWorkspaceInvites.id, inviteId))
    .limit(1);

  if (!invite) {
    throw new ServiceError("Bot approval request not found", 404);
  }
  if (invite.botOwnerId !== ownerId) {
    throw new ServiceError(
      "Only the bot owner can resolve this request",
      403,
    );
  }
  if (invite.status !== "pending") {
    throw new ServiceError(
      "Bot approval request is no longer pending",
      409,
    );
  }

  return invite;
}

export async function acceptBotWorkspaceInvite(
  inviteId: string,
  ownerId: string,
) {
  const result = await db.transaction(async (tx) => {
    const invite = await getInviteForResolution(tx, inviteId, ownerId);
    await lockWorkspace(tx, invite.workspaceId);
    await requireWorkspaceAdmin(tx, invite.workspaceId, invite.requesterId).catch(
      (error) => {
        if (error instanceof ServiceError && error.status === 403) {
          throw new ServiceError(
            "The requester is no longer a workspace admin",
            409,
          );
        }
        throw error;
      },
    );

    const [updated] = await tx
      .update(botWorkspaceInvites)
      .set({ status: "accepted", updatedAt: new Date() })
      .where(
        and(
          eq(botWorkspaceInvites.id, inviteId),
          eq(botWorkspaceInvites.status, "pending"),
        ),
      )
      .returning({ id: botWorkspaceInvites.id });
    if (!updated) {
      throw new ServiceError(
        "Bot approval request is no longer pending",
        409,
      );
    }

    const attachment = await attachBotMembership(tx, invite.workspaceId, {
      id: invite.botId,
      userId: invite.botUserId,
      ownerId: invite.botOwnerId,
      name: invite.botName,
      kind: invite.botKind,
    });
    const recipients = await getHumanWorkspaceRecipientIds(
      tx,
      invite.workspaceId,
    );
    const adminRecipients = await getHumanWorkspaceRecipientIds(
      tx,
      invite.workspaceId,
      true,
    );

    return { invite, attachment, recipients, adminRecipients };
  });

  if (result.attachment.inserted) {
    broadcastMemberJoined(
      result.invite.workspaceId,
      result.attachment.member,
      result.recipients,
    );
  }
  broadcastToRecipients(
    [...result.adminRecipients, result.invite.requesterId, ownerId],
    resolvedEvent(
      inviteId,
      result.invite.workspaceId,
      result.invite.botId,
      "accepted",
    ),
  );

  return {
    success: true,
    workspaceId: result.invite.workspaceId,
    botId: result.invite.botId,
  };
}

export async function declineBotWorkspaceInvite(
  inviteId: string,
  ownerId: string,
) {
  const result = await db.transaction(async (tx) => {
    const invite = await getInviteForResolution(tx, inviteId, ownerId);
    const [updated] = await tx
      .update(botWorkspaceInvites)
      .set({ status: "declined", updatedAt: new Date() })
      .where(
        and(
          eq(botWorkspaceInvites.id, inviteId),
          eq(botWorkspaceInvites.status, "pending"),
        ),
      )
      .returning({ id: botWorkspaceInvites.id });
    if (!updated) {
      throw new ServiceError(
        "Bot approval request is no longer pending",
        409,
      );
    }
    const admins = await getHumanWorkspaceRecipientIds(
      tx,
      invite.workspaceId,
      true,
    );
    return { invite, admins };
  });

  broadcastToRecipients(
    [...result.admins, result.invite.requesterId, ownerId],
    resolvedEvent(
      inviteId,
      result.invite.workspaceId,
      result.invite.botId,
      "declined",
    ),
  );
  return { success: true };
}

export async function cancelBotWorkspaceInvite(
  workspaceId: string,
  inviteId: string,
  callerId: string,
) {
  const result = await db.transaction(async (tx) => {
    await lockWorkspace(tx, workspaceId);
    await requireWorkspaceAdmin(tx, workspaceId, callerId);
    const [invite] = await tx
      .select({
        id: botWorkspaceInvites.id,
        botId: botWorkspaceInvites.botId,
        requesterId: botWorkspaceInvites.requesterId,
        ownerId: bots.ownerId,
        status: botWorkspaceInvites.status,
      })
      .from(botWorkspaceInvites)
      .innerJoin(bots, eq(botWorkspaceInvites.botId, bots.id))
      .where(
        and(
          eq(botWorkspaceInvites.id, inviteId),
          eq(botWorkspaceInvites.workspaceId, workspaceId),
        ),
      )
      .limit(1);
    if (!invite) {
      throw new ServiceError("Bot approval request not found", 404);
    }
    if (invite.status !== "pending") {
      throw new ServiceError(
        "Bot approval request is no longer pending",
        409,
      );
    }

    const [updated] = await tx
      .update(botWorkspaceInvites)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(
        and(
          eq(botWorkspaceInvites.id, inviteId),
          eq(botWorkspaceInvites.status, "pending"),
        ),
      )
      .returning({ id: botWorkspaceInvites.id });
    if (!updated) {
      throw new ServiceError(
        "Bot approval request is no longer pending",
        409,
      );
    }
    const admins = await getHumanWorkspaceRecipientIds(tx, workspaceId, true);
    return { invite, admins };
  });

  broadcastToRecipients(
    [result.invite.ownerId, result.invite.requesterId, ...result.admins],
    resolvedEvent(inviteId, workspaceId, result.invite.botId, "cancelled"),
  );
  return { success: true };
}

export async function removeBotWorkspaceMembership(
  botId: string,
  workspaceId: string,
  callerId: string,
) {
  const result = await removeBotFromWorkspace(botId, workspaceId, callerId);
  if (result.removed) {
    broadcastToRecipients(result.recipientIds, {
      type: "member_removed",
      workspaceId,
      userId: result.botUserId,
    });
  }
  return { success: result.success };
}
