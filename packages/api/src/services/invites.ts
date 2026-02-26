import { eq, and } from "drizzle-orm";
import { db } from "../db";
import {
  workspaces,
  workspaceMembers,
  workspaceInvites,
  users,
} from "../db/schema";
import { joinWorkspace } from "./workspaces";
import { ServiceError } from "./errors";
import type { WorkspaceInvite } from "@thechat/shared";

export async function createInvite(
  workspaceId: string,
  inviterUserId: string,
  inviteeEmail: string
): Promise<WorkspaceInvite & { inviteeId: string }> {
  // Check workspace exists
  const [workspace] = await db
    .select({ id: workspaces.id, name: workspaces.name })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);

  if (!workspace) {
    throw new ServiceError("Workspace not found", 404);
  }

  // Check inviter is owner or admin
  const [inviterMembership] = await db
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, inviterUserId)
      )
    )
    .limit(1);

  if (
    !inviterMembership ||
    (inviterMembership.role !== "owner" && inviterMembership.role !== "admin")
  ) {
    throw new ServiceError(
      "Only workspace owners and admins can invite users",
      403
    );
  }

  // Look up invitee by email
  const [invitee] = await db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(eq(users.email, inviteeEmail))
    .limit(1);

  if (!invitee) {
    throw new ServiceError("No user found with that email", 404);
  }

  // Check invitee isn't already a member
  const [existingMember] = await db
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, invitee.id)
      )
    )
    .limit(1);

  if (existingMember) {
    throw new ServiceError("User is already a member of this workspace", 409);
  }

  // Check no pending invite already exists
  const [existingInvite] = await db
    .select({ id: workspaceInvites.id })
    .from(workspaceInvites)
    .where(
      and(
        eq(workspaceInvites.workspaceId, workspaceId),
        eq(workspaceInvites.inviteeId, invitee.id),
        eq(workspaceInvites.status, "pending")
      )
    )
    .limit(1);

  if (existingInvite) {
    throw new ServiceError(
      "A pending invite already exists for this user",
      409
    );
  }

  // Get inviter name
  const [inviter] = await db
    .select({ name: users.name })
    .from(users)
    .where(eq(users.id, inviterUserId))
    .limit(1);

  // Insert invite
  const [invite] = await db
    .insert(workspaceInvites)
    .values({
      workspaceId,
      inviterId: inviterUserId,
      inviteeId: invitee.id,
    })
    .returning();

  return {
    id: invite.id,
    workspaceId: invite.workspaceId,
    workspaceName: workspace.name,
    inviterId: invite.inviterId,
    inviterName: inviter?.name ?? "Unknown",
    inviteeId: invitee.id,
    createdAt: invite.createdAt.toISOString(),
  };
}

export async function listPendingInvites(
  userId: string
): Promise<WorkspaceInvite[]> {
  const rows = await db
    .select({
      id: workspaceInvites.id,
      workspaceId: workspaceInvites.workspaceId,
      workspaceName: workspaces.name,
      inviterId: workspaceInvites.inviterId,
      inviterName: users.name,
      createdAt: workspaceInvites.createdAt,
    })
    .from(workspaceInvites)
    .innerJoin(workspaces, eq(workspaceInvites.workspaceId, workspaces.id))
    .innerJoin(users, eq(workspaceInvites.inviterId, users.id))
    .where(
      and(
        eq(workspaceInvites.inviteeId, userId),
        eq(workspaceInvites.status, "pending")
      )
    );

  return rows.map((r) => ({
    id: r.id,
    workspaceId: r.workspaceId,
    workspaceName: r.workspaceName,
    inviterId: r.inviterId,
    inviterName: r.inviterName,
    createdAt: r.createdAt.toISOString(),
  }));
}

export async function acceptInvite(inviteId: string, userId: string) {
  const [invite] = await db
    .select()
    .from(workspaceInvites)
    .where(eq(workspaceInvites.id, inviteId))
    .limit(1);

  if (!invite) {
    throw new ServiceError("Invite not found", 404);
  }

  if (invite.inviteeId !== userId) {
    throw new ServiceError("This invite belongs to another user", 403);
  }

  if (invite.status !== "pending") {
    throw new ServiceError("This invite has already been resolved", 400);
  }

  // Update status
  await db
    .update(workspaceInvites)
    .set({ status: "accepted" })
    .where(eq(workspaceInvites.id, inviteId));

  // Add user to workspace + channels
  await joinWorkspace(invite.workspaceId, userId);

  return { success: true, workspaceId: invite.workspaceId };
}

export async function declineInvite(inviteId: string, userId: string) {
  const [invite] = await db
    .select()
    .from(workspaceInvites)
    .where(eq(workspaceInvites.id, inviteId))
    .limit(1);

  if (!invite) {
    throw new ServiceError("Invite not found", 404);
  }

  if (invite.inviteeId !== userId) {
    throw new ServiceError("This invite belongs to another user", 403);
  }

  if (invite.status !== "pending") {
    throw new ServiceError("This invite has already been resolved", 400);
  }

  await db
    .update(workspaceInvites)
    .set({ status: "declined" })
    .where(eq(workspaceInvites.id, inviteId));
}
