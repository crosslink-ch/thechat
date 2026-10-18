import crypto from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { resolveBotAppearance } from "@thechat/shared";
import { db } from "../db";
import {
  workspaces,
  workspaceMembers,
  conversations,
  conversationParticipants,
  botIdentities as bots,
  users,
} from "../db/schema";
import { ServiceError } from "./errors";
import { lifecycleTransaction, stageLifecycleNotification } from "../events/workspace-lifecycle";
import { requireBotInstallationAccess } from "./bot-installation-access";

function generateWorkspaceId(name: string): string {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .substring(0, 50);
  const suffix = Math.floor(10000 + Math.random() * 90000);
  return `${slug}-${suffix}`;
}

export async function listUserWorkspaces(userId: string) {
  const memberships = await db
    .select({
      workspaceId: workspaceMembers.workspaceId,
      role: workspaceMembers.role,
      id: workspaces.id,
      name: workspaces.name,
      createdAt: workspaces.createdAt,
      updatedAt: workspaces.updatedAt,
    })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id))
    .where(eq(workspaceMembers.userId, userId));

  return memberships.map((m) => ({
    id: m.id,
    name: m.name,
    role: m.role,
    createdAt: m.createdAt.toISOString(),
    updatedAt: m.updatedAt.toISOString(),
  }));
}

export async function getWorkspaceDetail(workspaceId: string, userId: string) {
  // Check membership
  const [membership] = await db
    .select()
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, userId)
      )
    )
    .limit(1);

  if (!membership) {
    // Check if workspace exists at all
    const [workspace] = await db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1);

    if (!workspace) {
      throw new ServiceError("Workspace not found", 404);
    }

    throw new ServiceError("You are not a member of this workspace", 403);
  }

  const [workspace] = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);

  const members = await db
    .select({
      userId: workspaceMembers.userId,
      role: workspaceMembers.role,
      joinedAt: workspaceMembers.joinedAt,
      userName: users.name,
      userEmail: users.email,
      userAvatar: users.avatar,
      userType: users.type,
      botId: bots.id,
      botKind: bots.kind,
      botAvatarShape: bots.avatarShape,
      botAvatarColor: bots.avatarColor,
    })
    .from(workspaceMembers)
    .innerJoin(users, eq(workspaceMembers.userId, users.id))
    .leftJoin(bots, eq(bots.userId, users.id))
    .where(eq(workspaceMembers.workspaceId, workspaceId));

  const channels = await db
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.workspaceId, workspaceId),
        eq(conversations.type, "group"),
      ),
    );

  return {
    id: workspace.id,
    name: workspace.name,
    createdAt: workspace.createdAt.toISOString(),
    updatedAt: workspace.updatedAt.toISOString(),
    members: members.map((m) => ({
      userId: m.userId,
      role: m.role,
      joinedAt: m.joinedAt.toISOString(),
      user: {
        id: m.userId,
        name: m.userName,
        email: m.userEmail,
        avatar: m.userAvatar,
        type: m.userType,
      },
      bot: m.botId
        ? {
            id: m.botId,
            kind: m.botKind!,
            avatar: resolveBotAppearance(m.userId, {
              avatarShape: m.botAvatarShape,
              avatarColor: m.botAvatarColor,
            }),
          }
        : null,
    })),
    channels: (await filterAllowedChannels(channels, userId)).map((c) => ({
      id: c.id,
      workspaceId: c.workspaceId,
      name: c.name,
      title: c.title,
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
    })),
  };
}

export async function createWorkspace(name: string, userId: string, options: { afterOwnerInserted?: () => Promise<void> } = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const id = generateWorkspaceId(name);
    try {
      return await lifecycleTransaction(async tx => {
        // RLS cannot SELECT an INSERT RETURNING candidate before enrollment.
        await tx.insert(workspaces).values({ id, name, createdById: userId });
        await tx.insert(workspaceMembers).values({ workspaceId: id, userId, role: "owner" });
        await options.afterOwnerInserted?.();
        const channelId = crypto.randomUUID();
        await tx.insert(conversations).values({ id: channelId, title: "General", type: "group", workspaceId: id, name: "general" });
        await tx.insert(conversationParticipants).values({ conversationId: channelId, userId, role: "owner" });
        const [workspace] = await tx.select().from(workspaces).where(eq(workspaces.id, id)).limit(1);
        return { id: workspace.id, name: workspace.name, createdAt: workspace.createdAt.toISOString(), updatedAt: workspace.updatedAt.toISOString() };
      });
    } catch (error: any) {
      if (attempt < 2 && (error.code === "23505" || error.cause?.code === "23505")) continue;
      throw error;
    }
  }
  throw new ServiceError("Failed to generate unique workspace ID", 500);
}

async function filterAllowedChannels(channels: typeof conversations.$inferSelect[], userId: string) {
  const allowed = [];
  for (const channel of channels) {
    try { await requireBotInstallationAccess(db, channel.id, userId); allowed.push(channel); }
    catch (error) { if (!(error instanceof ServiceError) || error.status !== 403) throw error; }
  }
  return allowed;
}

export async function joinWorkspace(workspaceId: string, userId: string) {
  return lifecycleTransaction(tx => joinWorkspaceInTransaction(tx, workspaceId, userId));
}

export async function joinWorkspaceInTransaction(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], workspaceId: string, userId: string) {
    const [workspace] = await tx
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .for("update")
      .limit(1);

    if (!workspace) {
      throw new ServiceError("Workspace not found", 404);
    }

    const [existingMember] = await tx
      .select({ userId: workspaceMembers.userId })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.userId, userId),
        ),
      )
      .limit(1);

    if (!existingMember) {
      await tx.insert(workspaceMembers).values({
        workspaceId,
        userId,
        role: "member",
      });
    }

    const channels = await tx
      .select({ id: conversations.id })
      .from(conversations)
      .where(
        and(
          eq(conversations.workspaceId, workspaceId),
          eq(conversations.type, "group"),
        ),
      );

    if (channels.length > 0) {
      await tx
        .insert(conversationParticipants)
        .values(
          channels.map((channel) => ({
            conversationId: channel.id,
            userId,
            role: "member" as const,
          })),
        )
        .onConflictDoNothing();
    }

    if (!existingMember) {
      const [member] = await tx.select().from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId))).limit(1);
      const [user] = await tx.select().from(users).where(eq(users.id, userId)).limit(1);
      if (user.type === "human") {
        const recipients = await tx.select({ userId: workspaceMembers.userId }).from(workspaceMembers).where(eq(workspaceMembers.workspaceId, workspaceId));
        await stageLifecycleNotification(tx, workspaceId, recipients.map(r => r.userId), { type: "member_joined", workspaceId, member: { userId, role: member.role, joinedAt: member.joinedAt.toISOString(), user: { id: user.id, name: user.name, email: user.email, avatar: user.avatar, type: user.type } } });
      }
    }
    return { success: true };
}

export async function updateMemberRole(
  workspaceId: string,
  actorUserId: string,
  targetUserId: string,
  newRole: string,
  options: { afterWorkspaceLocked?: () => Promise<void> } = {},
) {
  if (newRole !== "member" && newRole !== "admin") {
    throw new ServiceError("Role must be 'member' or 'admin'", 400);
  }

  return lifecycleTransaction(async (tx) => {
    const [workspace] = await tx
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .for("update")
      .limit(1);

    if (!workspace) {
      throw new ServiceError("Workspace not found", 404);
    }

    await options.afterWorkspaceLocked?.();

    const [actor] = await tx
      .select({ role: workspaceMembers.role })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.userId, actorUserId),
        ),
      )
      .limit(1);

    if (!actor || (actor.role !== "owner" && actor.role !== "admin")) {
      throw new ServiceError("Only owners and admins can change roles", 403);
    }

    const [target] = await tx
      .select({ role: workspaceMembers.role })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.userId, targetUserId),
        ),
      )
      .limit(1);

    if (!target) {
      throw new ServiceError("Target user is not a member of this workspace", 404);
    }
    if (target.role === "owner") {
      throw new ServiceError("Cannot change the owner's role", 403);
    }
    if (actor.role === "admin" && target.role !== "member") {
      throw new ServiceError("Admins can only manage regular members", 403);
    }

    await tx
      .update(workspaceMembers)
      .set({ role: newRole })
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.userId, targetUserId),
        ),
      );

    const recipients = await tx.select({ userId: workspaceMembers.userId }).from(workspaceMembers).where(eq(workspaceMembers.workspaceId, workspaceId));
    await stageLifecycleNotification(tx, workspaceId, recipients.map(r => r.userId), { type: "member_role_changed", workspaceId, userId: targetUserId, newRole });
    return { success: true };
  });
}

export async function removeMember(
  workspaceId: string,
  actorUserId: string,
  targetUserId: string,
  options: { afterWorkspaceLocked?: () => Promise<void> } = {},
) {
  return lifecycleTransaction(async (tx) => {
    const [workspace] = await tx
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .for("update")
      .limit(1);

    if (!workspace) {
      throw new ServiceError("Workspace not found", 404);
    }

    await options.afterWorkspaceLocked?.();

    const [actor] = await tx
      .select({ role: workspaceMembers.role })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.userId, actorUserId),
        ),
      )
      .limit(1);

    if (!actor || (actor.role !== "owner" && actor.role !== "admin")) {
      throw new ServiceError("Only owners and admins can remove members", 403);
    }

    const [target] = await tx
      .select({ role: workspaceMembers.role })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.userId, targetUserId),
        ),
      )
      .limit(1);

    if (!target) {
      throw new ServiceError("Target user is not a member of this workspace", 404);
    }
    if (target.role === "owner") {
      throw new ServiceError("Cannot remove the workspace owner", 403);
    }
    if (actor.role === "admin" && target.role !== "member") {
      throw new ServiceError("Admins can only remove regular members", 403);
    }

    // Every workspace-bound conversation is workspace-owned, including DMs.
    const recipients = await tx.select({ userId: workspaceMembers.userId }).from(workspaceMembers).where(eq(workspaceMembers.workspaceId, workspaceId));
    const channels = await tx
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.workspaceId, workspaceId));

    if (channels.length > 0) {
      await tx
        .delete(conversationParticipants)
        .where(
          and(
            inArray(
              conversationParticipants.conversationId,
              channels.map((channel) => channel.id),
            ),
            eq(conversationParticipants.userId, targetUserId),
          ),
        );
    }

    await tx
      .delete(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.userId, targetUserId),
        ),
      );

    await stageLifecycleNotification(tx, workspaceId, recipients.map(r => r.userId), { type: "member_removed", workspaceId, userId: targetUserId });
    return { success: true };
  });
}
