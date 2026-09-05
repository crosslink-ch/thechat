import crypto from "crypto";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import type { BotCommandPublic, WsServerEvent } from "@thechat/shared";
import { db } from "../db";
import {
  users,
  bots,
  workspaceMembers,
  workspaces,
  conversations,
  conversationParticipants,
  apikey,
  botInvocations,
  botWorkspaceInvites,
  eventOutbox,
  hermesBotConfigs,
  hermesRpcBotConfigs,
} from "../db/schema";
import { ServiceError } from "./errors";
import { broadcastToUser } from "../ws";
import {
  BotApiKeyRotationConflictError,
  prepareBotApiKey,
  revokeBotApiKey,
  rotateBotApiKey,
} from "../auth/bot-api-keys";
import { BOT_API_KEY_CONFIG_ID } from "../auth/better-auth";
import { assertHermesGatewayEndpointAllowed } from "@thechat/hermes-proxy/endpoint";
import { encryptSecret } from "@thechat/hermes-proxy/secrets";
import { hermesGatewayTokenSchema } from "./hermes-rpc-config";
import { revokeDirectHermesWorkspaceAccess } from "./hermes-proxy-revocation";

export function generateWebhookSecret(): string {
  return `whsec_${crypto.randomBytes(32).toString("hex")}`;
}

export async function createBot(
  name: string,
  webhookUrl: string | null,
  ownerId: string,
  kind: "webhook" | "hermes" = "webhook",
  attachmentAccess = true,
) {
  const webhookSecret = generateWebhookSecret();
  const botUserId = crypto.randomUUID();
  const credential = await prepareBotApiKey(botUserId);

  const { botUser, bot } = await db.transaction(async (tx) => {
    const [createdUser] = await tx
      .insert(users)
      .values({ id: botUserId, name, type: "bot" })
      .returning({ id: users.id, name: users.name });

    const [createdBot] = await tx
      .insert(bots)
      .values({
        userId: createdUser.id,
        ownerId,
        webhookUrl,
        webhookSecret,
        kind,
        attachmentAccess,
      })
      .returning();

    await tx.insert(apikey).values(credential.values);

    return { botUser: createdUser, bot: createdBot };
  });

  return {
    id: bot.id,
    userId: botUser.id,
    name: botUser.name,
    apiKey: credential.rawKey,
    kind: bot.kind,
    attachmentAccess: bot.attachmentAccess,
    webhookUrl: bot.webhookUrl,
    webhookSecret: bot.webhookSecret,
    createdAt: bot.createdAt.toISOString(),
  };
}

export async function createHermesBotInWorkspace(
  name: string,
  webhookUrl: string | null,
  ownerId: string,
  workspaceId: string,
  attachmentAccess = true,
  options: {
    afterWorkspaceLocked?: () => Promise<void>;
    kind?: "hermes" | "hermes-rpc";
    hermesRpc?: { endpoint: string; gatewayToken: string };
  } = {},
) {
  const kind = options.kind ?? "hermes";
  let rpcEndpoint: string | null = null;
  let rpcTokenEncrypted: string | null = null;
  if (kind === "hermes-rpc") {
    const tokenResult = hermesGatewayTokenSchema.safeParse(options.hermesRpc?.gatewayToken);
    if (!tokenResult.success) throw new ServiceError("Invalid Hermes gateway token", 400);
    const gatewayToken = tokenResult.data;
    if (!options.hermesRpc?.endpoint.trim()) {
      throw new ServiceError("Hermes gateway URL is required", 400);
    }
    if (!gatewayToken) {
      throw new ServiceError("Hermes gateway token is required", 400);
    }
    try {
      rpcEndpoint = assertHermesGatewayEndpointAllowed(
        options.hermesRpc.endpoint,
      );
    } catch (error) {
      throw new ServiceError(
        error instanceof Error ? error.message : "Invalid Hermes gateway URL",
        400,
      );
    }
    rpcTokenEncrypted = encryptSecret(gatewayToken);
  }

  const webhookSecret = generateWebhookSecret();
  const botUserId = crypto.randomUUID();
  const credential = await prepareBotApiKey(botUserId);

  const { botUser, bot, joinedAt } = await db.transaction(async (tx) => {
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

    const [callerMembership] = await tx
      .select({ role: workspaceMembers.role })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.userId, ownerId),
        ),
      )
      .limit(1);
    if (!callerMembership) {
      throw new ServiceError("You are not a member of this workspace", 403);
    }
    if (callerMembership.role !== "owner" && callerMembership.role !== "admin") {
      throw new ServiceError("Only workspace admins can add bots", 403);
    }

    const [createdUser] = await tx
      .insert(users)
      .values({ id: botUserId, name, type: "bot" })
      .returning({ id: users.id, name: users.name });
    const [createdBot] = await tx
      .insert(bots)
      .values({
        userId: createdUser.id,
        ownerId,
        webhookUrl,
        webhookSecret,
        kind,
        attachmentAccess,
      })
      .returning();
    await tx.insert(apikey).values(credential.values);
    if (kind === "hermes") {
      await tx.insert(hermesBotConfigs).values({
        botId: createdBot.id,
        baseUrl: null,
        apiKeyEncrypted: null,
        defaultMode: "run",
      });
    } else {
      await tx.insert(hermesRpcBotConfigs).values({
        botId: createdBot.id,
        endpoint: rpcEndpoint!,
        gatewayTokenEncrypted: rpcTokenEncrypted!,
      });
    }
    const [membership] = await tx
      .insert(workspaceMembers)
      .values({
        workspaceId,
        userId: createdUser.id,
        role: "member",
      })
      .returning({ joinedAt: workspaceMembers.joinedAt });

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
      await tx.insert(conversationParticipants).values(
        channels.map((channel) => ({
          conversationId: channel.id,
          userId: createdUser.id,
          role: "member" as const,
        })),
      );
    }

    return {
      botUser: createdUser,
      bot: createdBot,
      joinedAt: membership.joinedAt,
    };
  });

  await broadcastBotJoinedWorkspace({
    workspaceId,
    botId: bot.id,
    botKind: kind,
    botUserId: botUser.id,
    botName: botUser.name,
    joinedAt,
  });

  return {
    id: bot.id,
    userId: botUser.id,
    name: botUser.name,
    apiKey: credential.rawKey,
    kind: bot.kind,
    attachmentAccess: bot.attachmentAccess,
    webhookUrl: bot.webhookUrl,
    webhookSecret: bot.webhookSecret,
    createdAt: bot.createdAt.toISOString(),
  };
}

export async function listBots(ownerId: string) {
  const rows = await db
    .select({
      id: bots.id,
      userId: bots.userId,
      webhookUrl: bots.webhookUrl,
      webhookSecret: bots.webhookSecret,
      kind: bots.kind,
      attachmentAccess: bots.attachmentAccess,
      createdAt: bots.createdAt,
      name: users.name,
    })
    .from(bots)
    .innerJoin(users, eq(bots.userId, users.id))
    .where(eq(bots.ownerId, ownerId));

  const metadata = await getBotManagementMetadata(rows.map((row) => row.userId));
  return rows.map((row) => serializeOwnedBot(row, metadata));
}

type OwnedBotRow = {
  id: string;
  userId: string;
  webhookUrl: string | null;
  webhookSecret: string;
  kind: "webhook" | "hermes" | "hermes-rpc";
  attachmentAccess: boolean;
  createdAt: Date;
  name: string;
};

type BotManagementMetadata = {
  workspacesByUserId: Map<string, Array<{ id: string; name: string }>>;
  apiKeyEnabledByUserId: Map<string, boolean>;
};

async function getBotManagementMetadata(
  botUserIds: string[],
): Promise<BotManagementMetadata> {
  const workspacesByUserId = new Map<string, Array<{ id: string; name: string }>>();
  const apiKeyEnabledByUserId = new Map<string, boolean>();

  if (botUserIds.length === 0) {
    return { workspacesByUserId, apiKeyEnabledByUserId };
  }

  const [memberships, credentials] = await Promise.all([
    db
      .select({
        userId: workspaceMembers.userId,
        id: workspaces.id,
        name: workspaces.name,
      })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
      .where(inArray(workspaceMembers.userId, botUserIds)),
    db
      .select({ userId: apikey.referenceId, enabled: apikey.enabled })
      .from(apikey)
      .where(
        and(
          eq(apikey.configId, BOT_API_KEY_CONFIG_ID),
          inArray(apikey.referenceId, botUserIds),
        ),
      ),
  ]);

  for (const membership of memberships) {
    const existing = workspacesByUserId.get(membership.userId) ?? [];
    existing.push({ id: membership.id, name: membership.name });
    workspacesByUserId.set(membership.userId, existing);
  }
  for (const workspaceList of workspacesByUserId.values()) {
    workspaceList.sort((a, b) => a.name.localeCompare(b.name));
  }
  for (const credential of credentials) {
    apiKeyEnabledByUserId.set(
      credential.userId,
      Boolean(apiKeyEnabledByUserId.get(credential.userId)) || credential.enabled,
    );
  }

  return { workspacesByUserId, apiKeyEnabledByUserId };
}

function serializeOwnedBot(row: OwnedBotRow, metadata: BotManagementMetadata) {
  return {
    id: row.id,
    userId: row.userId,
    name: row.name,
    kind: row.kind,
    attachmentAccess: row.attachmentAccess,
    webhookUrl: row.webhookUrl,
    webhookSecret: row.webhookSecret,
    apiKeyEnabled: metadata.apiKeyEnabledByUserId.get(row.userId) ?? false,
    workspaces: metadata.workspacesByUserId.get(row.userId) ?? [],
    createdAt: row.createdAt.toISOString(),
  };
}

export async function addBotToWorkspace(
  botId: string,
  workspaceId: string,
  callerId: string,
  options: { afterWorkspaceLocked?: () => Promise<void> } = {},
) {
  const [bot] = await db
    .select({
      id: bots.id,
      userId: bots.userId,
      ownerId: bots.ownerId,
      kind: bots.kind,
      name: users.name,
    })
    .from(bots)
    .innerJoin(users, eq(bots.userId, users.id))
    .where(eq(bots.id, botId))
    .limit(1);

  if (!bot) {
    throw new ServiceError("Bot not found", 404);
  }
  if (bot.ownerId !== callerId) {
    throw new ServiceError("Only the bot owner can add it directly", 403);
  }

  const result = await db.transaction(async (tx) => {
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

    const [callerMembership] = await tx
      .select({ role: workspaceMembers.role })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.userId, callerId),
        ),
      )
      .limit(1);
    if (
      !callerMembership ||
      (callerMembership.role !== "owner" && callerMembership.role !== "admin")
    ) {
      throw new ServiceError("Only workspace admins can add bots", 403);
    }

    const [existingMember] = await tx
      .select({ joinedAt: workspaceMembers.joinedAt })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.userId, bot.userId),
        ),
      )
      .limit(1);

    const [insertedMember] = existingMember
      ? []
      : await tx
          .insert(workspaceMembers)
          .values({
            workspaceId,
            userId: bot.userId,
            role: "member",
          })
          .returning({ joinedAt: workspaceMembers.joinedAt });

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
            userId: bot.userId,
            role: "member" as const,
          })),
        )
        .onConflictDoNothing();
    }

    return {
      added: !existingMember,
      joinedAt: existingMember?.joinedAt ?? insertedMember?.joinedAt ?? new Date(),
    };
  });

  if (result.added) {
    await broadcastBotJoinedWorkspace({
      workspaceId,
      botId,
      botKind: bot.kind,
      botUserId: bot.userId,
      botName: bot.name,
      joinedAt: result.joinedAt,
    });
  }

  return { success: true };
}

async function broadcastBotJoinedWorkspace({
  workspaceId,
  botId,
  botKind,
  botUserId,
  botName,
  joinedAt,
}: {
  workspaceId: string;
  botId: string;
  botKind: "webhook" | "hermes" | "hermes-rpc";
  botUserId: string;
  botName: string;
  joinedAt: Date;
}) {
  const members = await db
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.workspaceId, workspaceId));

  const event: WsServerEvent = {
    type: "member_joined",
    workspaceId,
    member: {
      userId: botUserId,
      role: "member",
      joinedAt: joinedAt.toISOString(),
      user: {
        id: botUserId,
        name: botName,
        email: null,
        avatar: null,
        type: "bot",
      },
      bot: { id: botId, kind: botKind },
    },
  };

  for (const member of members) {
    if (member.userId !== botUserId) {
      broadcastToUser(member.userId, event);
    }
  }
}

export async function removeBotFromWorkspace(
  botId: string,
  workspaceId: string,
  callerId: string,
  options: { afterWorkspaceLocked?: () => Promise<void> } = {},
) {
  const [bot] = await db
    .select({ userId: bots.userId, ownerId: bots.ownerId })
    .from(bots)
    .where(eq(bots.id, botId))
    .limit(1);

  if (!bot) {
    throw new ServiceError("Bot not found", 404);
  }

  const result = await db.transaction(async (tx) => {
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

    const [callerMembership] = await tx
      .select({ role: workspaceMembers.role })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.userId, callerId),
        ),
      )
      .limit(1);
    const callerIsWorkspaceAdmin =
      callerMembership?.role === "owner" || callerMembership?.role === "admin";
    if (bot.ownerId !== callerId && !callerIsWorkspaceAdmin) {
      throw new ServiceError(
        "Only the bot owner or a workspace admin can remove it",
        403,
      );
    }

    const workspaceConversations = await tx
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.workspaceId, workspaceId));

    const activeInvocations = await tx
      .select({ id: botInvocations.id })
      .from(botInvocations)
      .innerJoin(
        conversations,
        eq(botInvocations.conversationId, conversations.id),
      )
      .where(
        and(
          eq(botInvocations.botId, botId),
          eq(conversations.workspaceId, workspaceId),
          or(
            eq(botInvocations.status, "queued"),
            eq(botInvocations.status, "running"),
            and(
              eq(botInvocations.status, "claimed"),
              sql`NULLIF(${botInvocations.responseJson}->'completion'->>'type', '') IS NULL`,
              sql`COALESCE(${botInvocations.responseJson}->>'silent', 'false') <> 'true'`,
            ),
          ),
        ),
      );
    if (activeInvocations.length > 0) {
      const cancelledAt = new Date();
      await tx
        .update(botInvocations)
        .set({
          status: "cancelled",
          error: "Bot removed from workspace",
          completedAt: cancelledAt,
          updatedAt: cancelledAt,
        })
        .where(
          inArray(
            botInvocations.id,
            activeInvocations.map((invocation) => invocation.id),
          ),
        );
    }

    // Revoke durable work that was committed before this exclusive workspace
    // lock was acquired but has not yet been consumed. This prevents removed
    // bots from receiving it and avoids phantom work blocking channel deletion.
    await tx.execute(sql`
      with revoked as (
        select pending.id,
          coalesce(
            (
              select jsonb_agg(target.value)
              from jsonb_array_elements(
                pending.event->'payload'->'targetBotIds'
              ) as target(value)
              where target.value <> to_jsonb(${botId}::text)
            ),
            '[]'::jsonb
          ) as remaining_targets
        from ${eventOutbox} as pending
        where pending.event_type = 'chat.message.sent'
          and pending.published_at is null
          and pending.dead_at is null
          and pending.event->'tenant'->>'workspaceId' = ${workspaceId}
          and pending.event->'payload'->'targetBotIds' @> jsonb_build_array(${botId}::text)
      )
      update ${eventOutbox} as pending
      set event = jsonb_set(
            pending.event,
            '{payload,targetBotIds}',
            revoked.remaining_targets
          ),
          dead_at = case
            when jsonb_array_length(revoked.remaining_targets) = 0 then now()
            else pending.dead_at
          end,
          last_error = case
            when jsonb_array_length(revoked.remaining_targets) = 0
              then 'Target bot removed from workspace'
            else pending.last_error
          end,
          locked_by = case
            when jsonb_array_length(revoked.remaining_targets) = 0 then null
            else pending.locked_by
          end,
          locked_at = case
            when jsonb_array_length(revoked.remaining_targets) = 0 then null
            else pending.locked_at
          end
      from revoked
      where pending.id = revoked.id
    `);

    if (workspaceConversations.length > 0) {
      await tx
        .delete(conversationParticipants)
        .where(
          and(
            inArray(
              conversationParticipants.conversationId,
              workspaceConversations.map((conversation) => conversation.id),
            ),
            eq(conversationParticipants.userId, bot.userId),
          ),
        );
    }

    await revokeDirectHermesWorkspaceAccess(tx, workspaceId, bot.userId);

    const removedMemberships = await tx
      .delete(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.userId, bot.userId),
        ),
      )
      .returning({ userId: workspaceMembers.userId });

    const recipients =
      removedMemberships.length === 0
        ? []
        : await tx
            .select({ userId: workspaceMembers.userId })
            .from(workspaceMembers)
            .innerJoin(users, eq(users.id, workspaceMembers.userId))
            .where(
              and(
                eq(workspaceMembers.workspaceId, workspaceId),
                eq(users.type, "human"),
              ),
            );

    return {
      success: true,
      removed: removedMemberships.length > 0,
      botUserId: bot.userId,
      recipientIds: recipients.map((recipient) => recipient.userId),
    };
  });

  return result;
}

export async function getBot(botId: string, ownerId: string) {
  const [row] = await db
    .select({
      id: bots.id,
      userId: bots.userId,
      webhookUrl: bots.webhookUrl,
      webhookSecret: bots.webhookSecret,
      kind: bots.kind,
      attachmentAccess: bots.attachmentAccess,
      createdAt: bots.createdAt,
      ownerId: bots.ownerId,
      name: users.name,
    })
    .from(bots)
    .innerJoin(users, eq(bots.userId, users.id))
    .where(eq(bots.id, botId))
    .limit(1);

  if (!row) {
    throw new ServiceError("Bot not found", 404);
  }

  if (row.ownerId !== ownerId) {
    throw new ServiceError("Only the bot owner can view bot details", 403);
  }

  const metadata = await getBotManagementMetadata([row.userId]);
  return serializeOwnedBot(row, metadata);
}

export async function updateBot(
  botId: string,
  ownerId: string,
  updates: {
    name?: string;
    webhookUrl?: string | null;
    attachmentAccess?: boolean;
  },
) {
  const result = await db.transaction(async (tx) => {
    const [bot] = await tx
      .select({ id: bots.id, ownerId: bots.ownerId, userId: bots.userId })
      .from(bots)
      .where(eq(bots.id, botId))
      .limit(1);

    if (!bot) {
      throw new ServiceError("Bot not found", 404);
    }
    if (bot.ownerId !== ownerId) {
      throw new ServiceError("Only the bot owner can update the bot", 403);
    }

    let renameNotifications: Array<{
      workspaceId: string;
      recipients: Array<{ userId: string }>;
    }> = [];
    if (updates.name !== undefined) {
      await tx
        .update(users)
        .set({ name: updates.name })
        .where(eq(users.id, bot.userId));

      const memberships = await tx
        .select({ workspaceId: workspaceMembers.workspaceId })
        .from(workspaceMembers)
        .where(eq(workspaceMembers.userId, bot.userId));
      const workspaceIds = memberships.map((membership) => membership.workspaceId);
      if (workspaceIds.length > 0) {
        const recipientRows = await tx
          .select({
            workspaceId: workspaceMembers.workspaceId,
            userId: workspaceMembers.userId,
          })
          .from(workspaceMembers)
          .where(inArray(workspaceMembers.workspaceId, workspaceIds));
        renameNotifications = workspaceIds.map((workspaceId) => ({
          workspaceId,
          recipients: recipientRows
            .filter((recipient) => recipient.workspaceId === workspaceId)
            .map(({ userId }) => ({ userId })),
        }));
      }
    }

    if (
      updates.webhookUrl !== undefined ||
      updates.attachmentAccess !== undefined
    ) {
      await tx
        .update(bots)
        .set({
          ...(updates.webhookUrl !== undefined
            ? { webhookUrl: updates.webhookUrl }
            : {}),
          ...(updates.attachmentAccess !== undefined
            ? { attachmentAccess: updates.attachmentAccess }
            : {}),
        })
        .where(eq(bots.id, botId));
    }

    return { botUserId: bot.userId, renameNotifications };
  });

  if (updates.name !== undefined) {
    for (const notification of result.renameNotifications) {
      const event: WsServerEvent = {
        type: "member_updated",
        workspaceId: notification.workspaceId,
        userId: result.botUserId,
        name: updates.name,
      };
      for (const recipient of notification.recipients) {
        if (recipient.userId !== result.botUserId) {
          broadcastToUser(recipient.userId, event);
        }
      }
    }
  }

  return getBot(botId, ownerId);
}

export async function updateAuthenticatedBotWebhook(
  botUserId: string,
  webhookUrl: string | null
) {
  const [updatedBot] = await db
    .update(bots)
    .set({ webhookUrl })
    .where(eq(bots.userId, botUserId))
    .returning({
      id: bots.id,
      userId: bots.userId,
      kind: bots.kind,
      webhookSecret: bots.webhookSecret,
    });

  if (!updatedBot) {
    throw new ServiceError("Bot not found", 404);
  }

  const [botUser] = await db
    .select({ name: users.name })
    .from(users)
    .where(eq(users.id, botUserId))
    .limit(1);

  if (!botUser) {
    throw new ServiceError("Bot not found", 404);
  }

  return {
    id: updatedBot.id,
    userId: updatedBot.userId,
    name: botUser.name,
    kind: updatedBot.kind,
    webhookUrl,
    ...(webhookUrl ? { webhookSecret: updatedBot.webhookSecret } : {}),
  };
}

/** Normalize a registered command list: lowercase names, drop duplicate names/aliases (first wins). */
export function normalizeBotCommands(commands: BotCommandPublic[]): BotCommandPublic[] {
  const seen = new Set<string>();
  const result: BotCommandPublic[] = [];
  for (const entry of commands) {
    const command = entry.command.toLowerCase();
    if (seen.has(command)) continue;
    seen.add(command);
    const aliases = (entry.aliases ?? [])
      .map((alias) => alias.toLowerCase())
      .filter((alias) => {
        if (seen.has(alias)) return false;
        seen.add(alias);
        return true;
      });
    result.push({
      command,
      description: entry.description,
      argsHint: entry.argsHint?.trim() || null,
      category: entry.category?.trim() || null,
      ...(aliases.length > 0 ? { aliases } : {}),
    });
  }
  return result;
}

export async function updateAuthenticatedBotCommands(
  botUserId: string,
  commands: BotCommandPublic[] | null
) {
  const [bot] = await db
    .select({
      id: bots.id,
      userId: bots.userId,
      kind: bots.kind,
      name: users.name,
    })
    .from(bots)
    .innerJoin(users, eq(bots.userId, users.id))
    .where(eq(bots.userId, botUserId))
    .limit(1);

  if (!bot) {
    throw new ServiceError("Bot not found", 404);
  }

  const commandsJson = commands ? normalizeBotCommands(commands) : null;

  await db
    .update(bots)
    .set({ commandsJson })
    .where(eq(bots.id, bot.id));

  return {
    id: bot.id,
    userId: bot.userId,
    name: bot.name,
    kind: bot.kind,
    commands: commandsJson,
  };
}

export async function deleteBot(botId: string, ownerId: string) {
  await db.transaction(async (tx) => {
    const [bot] = await tx
      .select({ id: bots.id, ownerId: bots.ownerId, userId: bots.userId })
      .from(bots)
      .where(eq(bots.id, botId))
      .for("update")
      .limit(1);

    if (!bot) {
      throw new ServiceError("Bot not found", 404);
    }

    if (bot.ownerId !== ownerId) {
      throw new ServiceError("Only the bot owner can delete the bot", 403);
    }

    const [workspaceMembership] = await tx
      .select({ workspaceId: workspaceMembers.workspaceId })
      .from(workspaceMembers)
      .where(eq(workspaceMembers.userId, bot.userId))
      .limit(1);
    const [pendingInvite] = await tx
      .select({ id: botWorkspaceInvites.id })
      .from(botWorkspaceInvites)
      .where(
        and(
          eq(botWorkspaceInvites.botId, botId),
          eq(botWorkspaceInvites.status, "pending"),
        ),
      )
      .limit(1);
    if (workspaceMembership || pendingInvite) {
      throw new ServiceError(
        "Remove the bot from all workspaces and resolve pending workspace requests before deleting it",
        409,
      );
    }

    // The Better Auth API-key row cascades with the bot user.
    await tx.delete(bots).where(eq(bots.id, botId));
    await tx.delete(users).where(eq(users.id, bot.userId));
  });

  return { success: true };
}

export async function regenerateBotKey(botId: string, ownerId: string) {
  const [bot] = await db
    .select({ id: bots.id, ownerId: bots.ownerId, userId: bots.userId })
    .from(bots)
    .where(eq(bots.id, botId))
    .limit(1);

  if (!bot) {
    throw new ServiceError("Bot not found", 404);
  }

  if (bot.ownerId !== ownerId) {
    throw new ServiceError(
      "Only the bot owner can regenerate the API key",
      403
    );
  }

  let newApiKey: string;
  try {
    newApiKey = await rotateBotApiKey(bot.userId);
  } catch (error) {
    if (error instanceof BotApiKeyRotationConflictError) {
      throw new ServiceError("Bot API key changed concurrently; retry from fresh state", 409);
    }
    throw error;
  }

  return { apiKey: newApiKey };
}

export async function revokeBotKey(botId: string, ownerId: string) {
  const [bot] = await db
    .select({ id: bots.id, ownerId: bots.ownerId, userId: bots.userId })
    .from(bots)
    .where(eq(bots.id, botId))
    .limit(1);

  if (!bot) throw new ServiceError("Bot not found", 404);
  if (bot.ownerId !== ownerId) {
    throw new ServiceError("Only the bot owner can revoke the API key", 403);
  }

  await revokeBotApiKey(bot.userId);
  return { success: true };
}

export async function regenerateBotSecret(botId: string, ownerId: string) {
  const [bot] = await db
    .select({ id: bots.id, ownerId: bots.ownerId })
    .from(bots)
    .where(eq(bots.id, botId))
    .limit(1);

  if (!bot) {
    throw new ServiceError("Bot not found", 404);
  }

  if (bot.ownerId !== ownerId) {
    throw new ServiceError(
      "Only the bot owner can regenerate the webhook secret",
      403
    );
  }

  const newSecret = generateWebhookSecret();
  await db
    .update(bots)
    .set({ webhookSecret: newSecret })
    .where(eq(bots.id, botId));

  return { webhookSecret: newSecret };
}
