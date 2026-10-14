import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import {
  botRuntimeMetadata as bots,
  botIdentities,
  botWorkspaceInstallations,
  botInstallationChannels,
  conversations,
  workspaceMembers,
  workspaces,
  users,
} from "../db/schema";
import { ServiceError } from "./errors";

type Executor = Pick<typeof db, "select">;
export async function canBotAccessConversationAttachments(
  executor: Executor,
  conversationId: string,
  userId: string,
) {
  const [bot] = await executor
    .select()
    .from(botIdentities)
    .where(eq(botIdentities.userId, userId))
    .limit(1);
  if (!bot) return true;
  const [safety] = await executor.select({ attachmentAccess: bots.attachmentAccess }).from(bots).where(eq(bots.id, bot.id)).limit(1);
  if (!safety?.attachmentAccess) return false;
  try {
    const grant = await requireBotInstallationAccess(
      executor,
      conversationId,
      userId,
    );
    return grant === null || grant.attachmentAccess;
  } catch (error) {
    if (error instanceof ServiceError && error.status === 403) return false;
    throw error;
  }
}
/** Absence of an installation is denial, never a legacy permission fallback. */
export async function requireBotInstallationAccess(
  executor: Executor,
  conversationId: string,
  userId: string,
  options: { endpoint?: boolean } = {},
) {
  const [bot] = await executor
    .select()
    .from(botIdentities)
    .where(eq(botIdentities.userId, userId))
    .limit(1);
  if (!bot) return null;
  const [conversation] = await executor
    .select()
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);
  if (!conversation) throw new ServiceError('Bot installation does not permit this conversation',403);
  if (!conversation.workspaceId) return null; // Only a visible personal DM retains participant-based authority.
  const [grant] = await executor
    .select()
    .from(botWorkspaceInstallations)
    .where(
      and(
        eq(botWorkspaceInstallations.workspaceId, conversation.workspaceId),
        eq(botWorkspaceInstallations.botId, bot.id),
      ),
    )
    .limit(1);
  if (!grant?.enabled || !grant.sharedRuntimeConsent)
    throw new ServiceError(
      "Bot installation does not permit this conversation",
      403,
    );
  const [endpoint] = options.endpoint ? await executor.select({ webhookUrl: bots.webhookUrl, endpointRevision: bots.endpointRevision }).from(bots).where(eq(bots.id, bot.id)).limit(1) : [];
  if (
    options.endpoint &&
    (!endpoint || grant.approvedEndpointUrl !== endpoint.webhookUrl ||
      grant.approvedEndpointRevision !== endpoint.endpointRevision)
  )
    throw new ServiceError(
      "Bot endpoint is not approved for this workspace",
      403,
    );
  if (grant.channelScope !== "all") {
    const [channel] = await executor
      .select()
      .from(botInstallationChannels)
      .where(
        and(
          eq(botInstallationChannels.workspaceId, conversation.workspaceId),
          eq(botInstallationChannels.botId, bot.id),
          eq(botInstallationChannels.conversationId, conversationId),
        ),
      )
      .limit(1);
    if (!channel)
      throw new ServiceError(
        "Bot installation does not permit this conversation",
        403,
      );
  }
  return grant;
}

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
export interface BotInstallationInput {
  enabled: boolean;
  channelScope: "all" | "selected";
  conversationIds: string[];
  attachmentAccess: boolean;
  sharedRuntimeConsent: boolean;
  approveEndpoint?: boolean;
  expectedRevision: number;
}

export async function requireInstallationAdmin(
  executor: Executor,
  workspaceId: string,
  actorId: string,
) {
  const [actor] = await executor
    .select({ role: workspaceMembers.role, type: users.type })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, actorId),
      ),
    )
    .limit(1);
  if (!actor)
    throw new ServiceError("You are not a member of this workspace", 403);
  if (actor.type !== "human" || !["owner", "admin"].includes(actor.role))
    throw new ServiceError(
      "Only human workspace owners and admins can manage bot installations",
      403,
    );
}

/** Compatibility adapter for an explicit administrator-approved install operation. */
export async function createApprovedBotInstallation(
  tx: Transaction,
  workspaceId: string,
  botId: string,
  approvedById: string,
) {
  const [bot] = await tx.select().from(bots).where(eq(bots.id, botId)).limit(1);
  if (!bot) throw new ServiceError("Bot not found", 404);
  await tx
    .insert(botWorkspaceInstallations)
    .values({
      workspaceId,
      botId,
      enabled: true,
      channelScope: "all",
      attachmentAccess: bot.attachmentAccess,
      sharedRuntimeConsent: true,
      approvedEndpointUrl: bot.webhookUrl,
      approvedEndpointRevision: bot.endpointRevision,
      approvedById,
      revision: 1,
    })
    .onConflictDoNothing();
}

export async function getBotInstallation(
  workspaceId: string,
  botId: string,
  actorId: string,
) {
  await requireInstallationAdmin(db, workspaceId, actorId);
  const [grant] = await db
    .select()
    .from(botWorkspaceInstallations)
    .where(
      and(
        eq(botWorkspaceInstallations.workspaceId, workspaceId),
        eq(botWorkspaceInstallations.botId, botId),
      ),
    )
    .limit(1);
  if (!grant) throw new ServiceError("Bot installation not found", 404);
  const rows = await db
    .select()
    .from(botInstallationChannels)
    .where(
      and(
        eq(botInstallationChannels.workspaceId, workspaceId),
        eq(botInstallationChannels.botId, botId),
      ),
    );
  return {
    ...grant,
    conversationIds: rows.map((r) => r.conversationId).sort(),
    createdAt: grant.createdAt.toISOString(),
    updatedAt: grant.updatedAt.toISOString(),
  };
}

export async function updateBotInstallation(
  workspaceId: string,
  botId: string,
  actorId: string,
  input: BotInstallationInput,
) {
  await db.transaction(async (tx) => {
    const [workspace] = await tx
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .for("update")
      .limit(1);
    if (!workspace) throw new ServiceError("Workspace not found", 404);
    await requireInstallationAdmin(tx, workspaceId, actorId);
    const [grant] = await tx
      .select()
      .from(botWorkspaceInstallations)
      .where(
        and(
          eq(botWorkspaceInstallations.workspaceId, workspaceId),
          eq(botWorkspaceInstallations.botId, botId),
        ),
      )
      .limit(1);
    if (!grant) throw new ServiceError("Bot installation not found", 404);
    if (grant.revision !== input.expectedRevision)
      throw new ServiceError(
        "Installation revision changed; reload before approving",
        409,
      );
    const [bot] = await tx
      .select()
      .from(bots)
      .where(eq(bots.id, botId))
      .limit(1);
    await tx.execute(sql`select thechat_lock_bot_endpoint(${botId}::uuid)`);
    if (!bot) throw new ServiceError("Bot not found", 404);
    const [membership] = await tx
      .select()
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.userId, bot.userId),
        ),
      )
      .limit(1);
    if (!membership)
      throw new ServiceError("Bot is not installed in this workspace", 403);
    const ids = [...new Set(input.conversationIds)];
    if (input.channelScope !== "all" && input.channelScope !== "selected")
      throw new ServiceError("Invalid channel scope", 400);
    if (ids.length) {
      const channels = await tx
        .select({ id: conversations.id })
        .from(conversations)
        .where(
          and(
            eq(conversations.workspaceId, workspaceId),
            inArray(conversations.id, ids),
          ),
        );
      if (channels.length !== ids.length)
        throw new ServiceError(
          "Every allowed conversation must belong to this workspace",
          400,
        );
    }
    await tx
      .update(botWorkspaceInstallations)
      .set({
        enabled: input.enabled,
        channelScope: input.channelScope,
        attachmentAccess: input.attachmentAccess,
        sharedRuntimeConsent: input.sharedRuntimeConsent,
        ...(input.approveEndpoint
          ? {
              approvedEndpointUrl: bot.webhookUrl,
              approvedEndpointRevision: bot.endpointRevision,
            }
          : {}),
        approvedById: actorId,
        revision: sql`${botWorkspaceInstallations.revision} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(botWorkspaceInstallations.workspaceId, workspaceId),
          eq(botWorkspaceInstallations.botId, botId),
        ),
      );
    await tx
      .delete(botInstallationChannels)
      .where(
        and(
          eq(botInstallationChannels.workspaceId, workspaceId),
          eq(botInstallationChannels.botId, botId),
        ),
      );
    if (input.channelScope === "selected" && ids.length)
      await tx
        .insert(botInstallationChannels)
        .values(
          ids.map((conversationId) => ({ workspaceId, botId, conversationId })),
        );
  });
  return getBotInstallation(workspaceId, botId, actorId);
}
