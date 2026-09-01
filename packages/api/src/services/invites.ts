import { and, desc, eq } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "../db";
import {
  workspaces,
  workspaceMembers,
  workspaceInvites,
  users,
} from "../db/schema";
import { joinWorkspace } from "./workspaces";
import { ServiceError } from "./errors";
import type {
  PendingWorkspaceInvite,
  WorkspaceInvite,
} from "@thechat/shared";

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

const pendingInvitees = alias(users, "pending_workspace_invite_invitees");
const pendingInviters = alias(users, "pending_workspace_invite_inviters");

async function requireWorkspaceAdmin(
  tx: DbTransaction,
  workspaceId: string,
  userId: string,
) {
  const [workspace] = await tx
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  if (!workspace) {
    throw new ServiceError("Workspace not found", 404);
  }

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
      "Only workspace owners and admins can manage invitations",
      403,
    );
  }
}

async function lockWorkspace(tx: DbTransaction, workspaceId: string) {
  const [workspace] = await tx
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .for("update");
  if (!workspace) {
    throw new ServiceError("Workspace not found", 404);
  }
}

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

export async function listPendingWorkspaceInvites(
  workspaceId: string,
  userId: string,
): Promise<PendingWorkspaceInvite[]> {
  return db.transaction(async (tx) => {
    await requireWorkspaceAdmin(tx, workspaceId, userId);
    const rows = await tx
      .select({
        id: workspaceInvites.id,
        workspaceId: workspaceInvites.workspaceId,
        inviteeId: workspaceInvites.inviteeId,
        inviteeName: pendingInvitees.name,
        inviteeEmail: pendingInvitees.email,
        inviteeAvatar: pendingInvitees.avatar,
        inviterId: workspaceInvites.inviterId,
        inviterName: pendingInviters.name,
        createdAt: workspaceInvites.createdAt,
      })
      .from(workspaceInvites)
      .innerJoin(
        pendingInvitees,
        eq(workspaceInvites.inviteeId, pendingInvitees.id),
      )
      .innerJoin(
        pendingInviters,
        eq(workspaceInvites.inviterId, pendingInviters.id),
      )
      .where(
        and(
          eq(workspaceInvites.workspaceId, workspaceId),
          eq(workspaceInvites.status, "pending"),
        ),
      )
      .orderBy(desc(workspaceInvites.createdAt));

    return rows.map((invite) => ({
      ...invite,
      createdAt: invite.createdAt.toISOString(),
    }));
  });
}

export async function revokeWorkspaceInvite(
  workspaceId: string,
  inviteId: string,
  userId: string,
) {
  await db.transaction(async (tx) => {
    await lockWorkspace(tx, workspaceId);
    await requireWorkspaceAdmin(tx, workspaceId, userId);
    const [invite] = await tx
      .select({ status: workspaceInvites.status })
      .from(workspaceInvites)
      .where(
        and(
          eq(workspaceInvites.id, inviteId),
          eq(workspaceInvites.workspaceId, workspaceId),
        ),
      )
      .limit(1);
    if (!invite) {
      throw new ServiceError("Invitation not found", 404);
    }
    if (invite.status !== "pending") {
      throw new ServiceError("Invitation is no longer pending", 409);
    }

    const [updated] = await tx
      .update(workspaceInvites)
      .set({ status: "cancelled" })
      .where(
        and(
          eq(workspaceInvites.id, inviteId),
          eq(workspaceInvites.workspaceId, workspaceId),
          eq(workspaceInvites.status, "pending"),
        ),
      )
      .returning({ id: workspaceInvites.id });
    if (!updated) {
      throw new ServiceError("Invitation is no longer pending", 409);
    }
  });

  return { success: true };
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

  if (invite.status === "cancelled") {
    throw new ServiceError("This invitation is no longer pending", 409);
  }
  if (invite.status !== "pending") {
    throw new ServiceError("This invite has already been resolved", 400);
  }

  // Resolve atomically so a concurrent revocation cannot be overwritten.
  const [updated] = await db
    .update(workspaceInvites)
    .set({ status: "accepted" })
    .where(
      and(
        eq(workspaceInvites.id, inviteId),
        eq(workspaceInvites.status, "pending"),
      ),
    )
    .returning({ id: workspaceInvites.id });
  if (!updated) {
    throw new ServiceError("This invitation is no longer pending", 409);
  }

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

  if (invite.status === "cancelled") {
    throw new ServiceError("This invitation is no longer pending", 409);
  }
  if (invite.status !== "pending") {
    throw new ServiceError("This invite has already been resolved", 400);
  }

  const [updated] = await db
    .update(workspaceInvites)
    .set({ status: "declined" })
    .where(
      and(
        eq(workspaceInvites.id, inviteId),
        eq(workspaceInvites.status, "pending"),
      ),
    )
    .returning({ id: workspaceInvites.id });
  if (!updated) {
    throw new ServiceError("This invitation is no longer pending", 409);
  }
}
