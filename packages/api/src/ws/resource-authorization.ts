import { and, eq, sql } from "drizzle-orm";
import type { WsServerEvent } from "@thechat/shared";
import { db } from "../db";
import {
  botIdentities as bots,
  botWorkspaceInstallations,
  botWorkspaceInvites,
  workspaceInvites,
  workspaceMembers,
  workspaces,
  users,
} from "../db/schema";
import { requireConversationMutationAccess } from "../services/conversation-mutation-access";
import { canUserAccessAttachments } from "../services/messages";
import { ServiceError } from "../services/errors";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
/** Hold the same workspace lock as removal through the synchronous socket sink.
 * Recipient capture is only routing; it is never resource authority.
 */
export async function withAuthorizedRealtimeEvent(
  userId: string,
  event: WsServerEvent,
  deliver: (event: WsServerEvent) => Promise<void> | void,
) {
  try {
    await db.transaction(async (tx) => {
      const projected = await authorize(tx, userId, event);
      if (projected) await deliver(projected);
    });
  } catch (error) {
    if (
      error instanceof ServiceError &&
      (error.status === 403 || error.status === 404)
    )
      return;
    throw error; // Store outage fails closed; caller logs and retries a later event.
  }
}
async function sharedPeers(
  tx: Transaction,
  userId: string,
  candidates: string[],
) {
  if (!candidates.length) return [];
  const [recipient] = await tx
    .select({ type: users.type })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (recipient?.type !== "human") return [];
  // Lock all current common workspaces in deterministic order, then re-read peers.
  await tx.execute(
    sql`SELECT w.id FROM workspaces w WHERE EXISTS (SELECT 1 FROM workspace_members me JOIN workspace_members peer ON peer.workspace_id=me.workspace_id WHERE me.user_id=${userId}::uuid AND me.workspace_id=w.id AND peer.user_id IN (${sql.join(
      candidates.map((id) => sql`${id}::uuid`),
      sql`, `,
    )})) ORDER BY w.id FOR KEY SHARE`,
  );
  const rows = await tx.execute<{ id: string }>(
    sql`SELECT DISTINCT peer.user_id AS id FROM workspace_members me JOIN workspace_members peer ON peer.workspace_id=me.workspace_id JOIN users u ON u.id=peer.user_id WHERE me.user_id=${userId}::uuid AND peer.user_id IN (${sql.join(
      candidates.map((id) => sql`${id}::uuid`),
      sql`, `,
    )}) AND u.type='human'`,
  );
  return Array.from(rows, (r) => r.id);
}
async function workspaceAccess(
  tx: Transaction,
  workspaceId: string,
  userId: string,
) {
  await tx
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .for("key share");
  const [member] = await tx
    .select()
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, userId),
      ),
    )
    .limit(1);
  if (!member) throw new ServiceError("Workspace access revoked", 403);
  const [bot] = await tx
    .select({ id: bots.id })
    .from(bots)
    .where(eq(bots.userId, userId))
    .limit(1);
  if (bot) {
    const [grant] = await tx
      .select()
      .from(botWorkspaceInstallations)
      .where(
        and(
          eq(botWorkspaceInstallations.workspaceId, workspaceId),
          eq(botWorkspaceInstallations.botId, bot.id),
        ),
      )
      .limit(1);
    if (!grant?.enabled || !grant.sharedRuntimeConsent)
      throw new ServiceError("Bot installation access revoked", 403);
  }
}
async function authorize(
  tx: Transaction,
  userId: string,
  event: WsServerEvent,
): Promise<WsServerEvent | null> {
  if (event.type === "presence_changed")
    return (await sharedPeers(tx, userId, [event.userId])).length
      ? event
      : null;
  if (event.type === "presence_snapshot")
    return { ...event, userIds: await sharedPeers(tx, userId, event.userIds) };
  if (event.type === "invite_received") {
    const [invite] = await tx
      .select()
      .from(workspaceInvites)
      .where(eq(workspaceInvites.id, event.invite.id))
      .limit(1);
    if (!invite || invite.inviteeId !== userId || invite.status !== "pending")
      return null;
    const [authorization] = await tx.execute<{allowed:boolean}>(sql`select thechat_inviter_authorized(${invite.id}::uuid) as allowed`);
    return authorization?.allowed ? event : null;
  }
  if (
    event.type === "bot_workspace_invite_received" ||
    event.type === "bot_workspace_invite_resolved"
  ) {
    const id =
      event.type === "bot_workspace_invite_received"
        ? event.invite.id
        : event.inviteId;
    const [invite] = await tx
      .select({
        ownerId: bots.ownerId,
        requesterId: botWorkspaceInvites.requesterId,
        workspaceId: botWorkspaceInvites.workspaceId,
        status: botWorkspaceInvites.status,
      })
      .from(botWorkspaceInvites)
      .innerJoin(bots, eq(bots.id, botWorkspaceInvites.botId))
      .where(eq(botWorkspaceInvites.id, id))
      .limit(1);
    if (!invite) return null;
    if (event.type === "bot_workspace_invite_received") {
      if (invite.ownerId !== userId || invite.status !== "pending") return null;
      const [authorization] = await tx.execute<{allowed:boolean}>(sql`select thechat_bot_inviter_authorized(${id}::uuid) as allowed`);
      return authorization?.allowed ? event : null;
    }
    // Resolution is an identifier-only invalidation, also safe for departed requesters.
    if (invite.ownerId === userId || invite.requesterId === userId)
      return event;
    await workspaceAccess(tx, invite.workspaceId, userId);
    return event;
  }
  // Only the removed subject may receive this identifier-only invalidation without membership.
  if (event.type === "member_removed" && event.userId === userId) return event;
  const conversationId =
    event.type === "new_message"
      ? event.message.conversationId
      : "conversationId" in event
        ? event.conversationId
        : event.type === "channel_created" || event.type === "channel_renamed"
          ? event.channel.id
          : null;
  if (conversationId) {
    await requireConversationMutationAccess(tx, conversationId, userId);
    if (
      event.type === "new_message" &&
      !(await canUserAccessAttachments(tx, userId, conversationId))
    )
      return { ...event, message: { ...event.message, attachments: [] } };
    return event;
  }
  if ("workspaceId" in event) {
    await workspaceAccess(tx, event.workspaceId, userId);
    return event;
  }
  return ["error", "pong", "auth_ok", "auth_error"].includes(event.type)
    ? event
    : null;
}
