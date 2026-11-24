import type { WorkspaceChannel, WorkspaceMember } from "@thechat/shared";

export interface ChannelAccess {
  /** In the channel: a participant of a private one, or in the workspace. */
  isMember: boolean;
  isChannelAdmin: boolean;
  /** Rename, delete, change visibility, remove people, appoint admins. */
  canManage: boolean;
  canAddMembers: boolean;
  canLeave: boolean;
}

/**
 * What the given person may do with a channel. The server enforces the same
 * rules; this only decides which controls to offer.
 *
 * Public channels are managed by workspace owners and admins. A private
 * channel is managed by its own admins, and by a workspace owner or admin
 * who is in it.
 */
export function channelAccess(
  channel: WorkspaceChannel | null | undefined,
  workspaceMembers: WorkspaceMember[] | undefined,
  userId: string | null | undefined,
): ChannelAccess {
  const none = { isMember: false, isChannelAdmin: false, canManage: false, canAddMembers: false, canLeave: false };
  if (!channel || !userId) return none;
  const workspaceRole = workspaceMembers?.find((member) => member.userId === userId)?.role;
  if (!workspaceRole) return none;
  const managesWorkspace = workspaceRole === "owner" || workspaceRole === "admin";
  if (!channel.isPrivate) {
    return { ...none, isMember: true, canManage: managesWorkspace };
  }
  const membership = channel.members?.find((member) => member.userId === userId);
  if (!membership) return none;
  const isChannelAdmin = membership.role === "admin";
  return {
    isMember: true,
    isChannelAdmin,
    canManage: isChannelAdmin || managesWorkspace,
    canAddMembers: true,
    canLeave: true,
  };
}

/** How many people and bots are in the channel. */
export function channelMemberCount(
  channel: WorkspaceChannel,
  workspaceMembers: WorkspaceMember[] | undefined,
) {
  return channel.isPrivate ? channel.members?.length ?? 0 : workspaceMembers?.length ?? 0;
}

/**
 * Whether a workspace member can be reached in the channel, for example by an
 * @mention. A public channel reaches the whole workspace.
 */
export function channelIncludes(
  channel: WorkspaceChannel | null | undefined,
  userId: string,
) {
  if (!channel?.isPrivate) return true;
  return channel.members?.some((member) => member.userId === userId) ?? false;
}
