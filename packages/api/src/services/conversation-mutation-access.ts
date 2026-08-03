import { and, eq } from "drizzle-orm";
import { db } from "../db";
import {
  conversationParticipants,
  conversations,
  users,
  workspaceMembers,
  workspaces,
} from "../db/schema";
import { ServiceError } from "./errors";

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface ConversationMutationAccess {
  conversationId: string;
  conversationType: "direct" | "group";
  workspaceId: string | null;
  senderType: "human" | "bot";
}

/**
 * Establishes the lock order for a workspace-conversation mutation:
 * workspace row -> current membership/participation -> child writes.
 *
 * Shared workspace locks let ordinary writes proceed concurrently while
 * serializing them with member/bot removal and channel deletion, which take
 * the same row FOR UPDATE and revalidate authorization after it is acquired.
 */
export async function requireConversationMutationAccess(
  executor: DbTransaction,
  conversationId: string,
  userId: string,
  options: { afterWorkspaceLocked?: () => Promise<void> } = {},
): Promise<ConversationMutationAccess> {
  const [conversation] = await executor
    .select({
      id: conversations.id,
      type: conversations.type,
      workspaceId: conversations.workspaceId,
    })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);

  if (!conversation) {
    throw new ServiceError("You are not a participant of this conversation", 403);
  }

  if (conversation.type === "group" && !conversation.workspaceId) {
    throw new ServiceError("You are not a participant of this conversation", 403);
  }

  if (conversation.workspaceId) {
    const [workspace] = await executor
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.id, conversation.workspaceId))
      .for("key share")
      .limit(1);
    if (!workspace) {
      throw new ServiceError("You are not a participant of this conversation", 403);
    }
    await options.afterWorkspaceLocked?.();
  }

  const [participant] = await executor
    .select({
      userId: conversationParticipants.userId,
      senderType: users.type,
    })
    .from(conversationParticipants)
    .innerJoin(users, eq(conversationParticipants.userId, users.id))
    .where(
      and(
        eq(conversationParticipants.conversationId, conversationId),
        eq(conversationParticipants.userId, userId),
      ),
    )
    .limit(1);

  if (!participant) {
    throw new ServiceError("You are not a participant of this conversation", 403);
  }

  if (conversation.workspaceId) {
    const [membership] = await executor
      .select({ userId: workspaceMembers.userId })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, conversation.workspaceId),
          eq(workspaceMembers.userId, userId),
        ),
      )
      .limit(1);
    if (!membership) {
      throw new ServiceError("You are not a participant of this conversation", 403);
    }
  }

  return {
    conversationId: conversation.id,
    conversationType: conversation.type,
    workspaceId: conversation.workspaceId,
    senderType: participant.senderType,
  };
}
