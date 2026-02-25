import { eq, and } from "drizzle-orm";
import { db } from "../db";
import {
  workspaces,
  workspaceMembers,
  conversations,
  conversationParticipants,
  users,
} from "../db/schema";
import { ServiceError } from "./errors";

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
    })
    .from(workspaceMembers)
    .innerJoin(users, eq(workspaceMembers.userId, users.id))
    .where(eq(workspaceMembers.workspaceId, workspaceId));

  const channels = await db
    .select()
    .from(conversations)
    .where(eq(conversations.workspaceId, workspaceId));

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
    })),
    channels: channels.map((c) => ({
      id: c.id,
      workspaceId: c.workspaceId,
      name: c.name,
      title: c.title,
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
    })),
  };
}

export async function createWorkspace(name: string, userId: string) {
  // Retry slug generation on collision (max 3 attempts)
  let id = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    id = generateWorkspaceId(name);
    const [existing] = await db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.id, id))
      .limit(1);
    if (!existing) break;
    if (attempt === 2) {
      throw new ServiceError("Failed to generate unique workspace ID", 500);
    }
  }

  const [workspace] = await db
    .insert(workspaces)
    .values({ id, name, createdById: userId })
    .returning();

  // Add creator as owner
  await db.insert(workspaceMembers).values({
    workspaceId: id,
    userId,
    role: "owner",
  });

  // Create default "General" channel
  const [channel] = await db
    .insert(conversations)
    .values({
      title: "General",
      type: "group",
      workspaceId: id,
      name: "general",
    })
    .returning();

  await db.insert(conversationParticipants).values({
    conversationId: channel.id,
    userId,
    role: "owner",
  });

  return {
    id: workspace.id,
    name: workspace.name,
    createdAt: workspace.createdAt.toISOString(),
    updatedAt: workspace.updatedAt.toISOString(),
  };
}

export async function joinWorkspace(workspaceId: string, userId: string) {
  const [workspace] = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);

  if (!workspace) {
    throw new ServiceError("Workspace not found", 404);
  }

  // Check if already a member (idempotent)
  const [existingMember] = await db
    .select()
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, userId)
      )
    )
    .limit(1);

  if (!existingMember) {
    await db.insert(workspaceMembers).values({
      workspaceId,
      userId,
      role: "member",
    });
  }

  // Add user to all existing channels in the workspace
  const channels = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(eq(conversations.workspaceId, workspaceId));

  for (const channel of channels) {
    const [existingParticipant] = await db
      .select()
      .from(conversationParticipants)
      .where(
        and(
          eq(conversationParticipants.conversationId, channel.id),
          eq(conversationParticipants.userId, userId)
        )
      )
      .limit(1);

    if (!existingParticipant) {
      await db.insert(conversationParticipants).values({
        conversationId: channel.id,
        userId,
        role: "member",
      });
    }
  }

  return { success: true };
}

export async function updateMemberRole(
  workspaceId: string,
  actorUserId: string,
  targetUserId: string,
  newRole: string
) {
  if (newRole !== "member" && newRole !== "admin") {
    throw new ServiceError("Role must be 'member' or 'admin'", 400);
  }

  // Check workspace exists
  const [workspace] = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);

  if (!workspace) {
    throw new ServiceError("Workspace not found", 404);
  }

  // Check actor is owner or admin
  const [actor] = await db
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, actorUserId)
      )
    )
    .limit(1);

  if (!actor || (actor.role !== "owner" && actor.role !== "admin")) {
    throw new ServiceError("Only owners and admins can change roles", 403);
  }

  // Check target is a member
  const [target] = await db
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, targetUserId)
      )
    )
    .limit(1);

  if (!target) {
    throw new ServiceError("Target user is not a member of this workspace", 404);
  }

  if (target.role === "owner") {
    throw new ServiceError("Cannot change the owner's role", 403);
  }

  // Admins can only manage regular members
  if (actor.role === "admin" && target.role !== "member") {
    throw new ServiceError("Admins can only manage regular members", 403);
  }

  await db
    .update(workspaceMembers)
    .set({ role: newRole })
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, targetUserId)
      )
    );

  return { success: true };
}

export async function removeMember(
  workspaceId: string,
  actorUserId: string,
  targetUserId: string
) {
  // Check workspace exists
  const [workspace] = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);

  if (!workspace) {
    throw new ServiceError("Workspace not found", 404);
  }

  // Check actor is owner or admin
  const [actor] = await db
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, actorUserId)
      )
    )
    .limit(1);

  if (!actor || (actor.role !== "owner" && actor.role !== "admin")) {
    throw new ServiceError("Only owners and admins can remove members", 403);
  }

  // Check target is a member
  const [target] = await db
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, targetUserId)
      )
    )
    .limit(1);

  if (!target) {
    throw new ServiceError("Target user is not a member of this workspace", 404);
  }

  if (target.role === "owner") {
    throw new ServiceError("Cannot remove the workspace owner", 403);
  }

  // Admins can only remove regular members
  if (actor.role === "admin" && target.role !== "member") {
    throw new ServiceError("Admins can only remove regular members", 403);
  }

  // Remove from workspace members
  await db
    .delete(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, targetUserId)
      )
    );

  // Remove from all workspace channels
  const channels = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(eq(conversations.workspaceId, workspaceId));

  for (const channel of channels) {
    await db
      .delete(conversationParticipants)
      .where(
        and(
          eq(conversationParticipants.conversationId, channel.id),
          eq(conversationParticipants.userId, targetUserId)
        )
      );
  }

  return { success: true };
}
