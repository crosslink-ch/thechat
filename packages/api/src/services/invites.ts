import { eq, and } from "drizzle-orm";
import { db } from "../db";
import {
  workspaces,
  workspaceMembers,
  workspaceInvites,
  users,
} from "../db/schema";
import { joinWorkspaceInTransaction } from "./workspaces";
import { requireInstallationAdmin } from "./bot-installation-access";
import { ServiceError } from "./errors";
import type { WorkspaceInvite } from "@thechat/shared";
import {
  lifecycleTransaction,
  stageLifecycleNotification,
} from "../events/workspace-lifecycle";
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
async function lockWorkspace(tx: Transaction, workspaceId: string) {
  const [workspace] = await tx
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .for("update")
    .limit(1);
  if (!workspace) throw new ServiceError("Workspace not found", 404);
  return workspace;
}
export async function createInvite(
  workspaceId: string,
  inviterUserId: string,
  inviteeEmail: string,
  options: { afterWorkspaceLocked?: () => Promise<void> } = {},
): Promise<WorkspaceInvite & { inviteeId: string }> {
  return lifecycleTransaction(async (tx) => {
    const workspace = await lockWorkspace(tx, workspaceId);
    await options.afterWorkspaceLocked?.();
    await requireInstallationAdmin(tx, workspaceId, inviterUserId);
    const [invitee] = await tx
      .select()
      .from(users)
      .where(eq(users.email, inviteeEmail))
      .limit(1);
    if (!invitee) throw new ServiceError("No user found with that email", 404);
    const [member] = await tx
      .select()
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.userId, invitee.id),
        ),
      )
      .limit(1);
    if (member)
      throw new ServiceError("User is already a member of this workspace", 409);
    const [pending] = await tx
      .select()
      .from(workspaceInvites)
      .where(
        and(
          eq(workspaceInvites.workspaceId, workspaceId),
          eq(workspaceInvites.inviteeId, invitee.id),
          eq(workspaceInvites.status, "pending"),
        ),
      )
      .limit(1);
    if (pending)
      throw new ServiceError(
        "A pending invite already exists for this user",
        409,
      );
    const [inviter] = await tx
      .select()
      .from(users)
      .where(eq(users.id, inviterUserId))
      .limit(1);
    const [invite] = await tx
      .insert(workspaceInvites)
      .values({ workspaceId, inviterId: inviterUserId, inviteeId: invitee.id })
      .returning();
    const view = {
      id: invite.id,
      workspaceId,
      workspaceName: workspace.name,
      inviterId: inviterUserId,
      inviterName: inviter.name,
      inviteeId: invitee.id,
      createdAt: invite.createdAt.toISOString(),
    };
    await stageLifecycleNotification(tx, workspaceId, [invitee.id], {
      type: "invite_received",
      invite: view,
    });
    return view;
  });
}
export async function listPendingInvites(
  userId: string,
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
        eq(workspaceInvites.status, "pending"),
      ),
    );
  return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
}
async function lockInvite(
  tx: Transaction,
  inviteId: string,
  userId: string,
  options: { afterWorkspaceLocked?: () => Promise<void> },
) {
  const [candidate] = await tx
    .select()
    .from(workspaceInvites)
    .where(eq(workspaceInvites.id, inviteId))
    .limit(1);
  if (!candidate) throw new ServiceError("Invite not found", 404);
  if (candidate.inviteeId !== userId)
    throw new ServiceError("This invite belongs to another user", 403);
  await lockWorkspace(tx, candidate.workspaceId);
  await options.afterWorkspaceLocked?.();
  const [invite] = await tx
    .select()
    .from(workspaceInvites)
    .where(eq(workspaceInvites.id, inviteId))
    .for("update")
    .limit(1);
  if (!invite || invite.status !== "pending")
    throw new ServiceError("This invite has already been resolved", 400);
  return invite;
}
export async function acceptInvite(
  inviteId: string,
  userId: string,
  options: {
    afterWorkspaceLocked?: () => Promise<void>;
    afterEnrollment?: () => Promise<void>;
  } = {},
) {
  return lifecycleTransaction(async (tx) => {
    const invite = await lockInvite(tx, inviteId, userId, options);
    // Authority is live, not captured when the invitation was created.
    await requireInstallationAdmin(tx, invite.workspaceId, invite.inviterId);
    await joinWorkspaceInTransaction(tx, invite.workspaceId, userId);
    await options.afterEnrollment?.();
    await tx
      .update(workspaceInvites)
      .set({ status: "accepted" })
      .where(eq(workspaceInvites.id, inviteId));
    return { success: true, workspaceId: invite.workspaceId };
  });
}
export async function declineInvite(
  inviteId: string,
  userId: string,
  options: { afterWorkspaceLocked?: () => Promise<void> } = {},
) {
  await lifecycleTransaction(async (tx) => {
    await lockInvite(tx, inviteId, userId, options);
    await tx
      .update(workspaceInvites)
      .set({ status: "declined" })
      .where(eq(workspaceInvites.id, inviteId));
  });
}
