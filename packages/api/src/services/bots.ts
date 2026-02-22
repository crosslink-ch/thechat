import crypto from "crypto";
import { eq, and } from "drizzle-orm";
import { db } from "../db";
import {
  users,
  bots,
  workspaceMembers,
  conversations,
  conversationParticipants,
} from "../db/schema";
import { ServiceError } from "./errors";

export function generateApiKey(): string {
  return `bot_${crypto.randomBytes(32).toString("hex")}`;
}

export function generateWebhookSecret(): string {
  return `whsec_${crypto.randomBytes(32).toString("hex")}`;
}

export async function createBot(
  name: string,
  webhookUrl: string | null,
  ownerId: string
) {
  const apiKey = generateApiKey();
  const webhookSecret = generateWebhookSecret();

  const [botUser] = await db
    .insert(users)
    .values({ name, type: "bot" })
    .returning({ id: users.id, name: users.name });

  const [bot] = await db
    .insert(bots)
    .values({
      userId: botUser.id,
      ownerId,
      webhookUrl,
      webhookSecret,
      apiKey,
    })
    .returning();

  return {
    id: bot.id,
    userId: botUser.id,
    name: botUser.name,
    apiKey,
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
      createdAt: bots.createdAt,
      name: users.name,
    })
    .from(bots)
    .innerJoin(users, eq(bots.userId, users.id))
    .where(eq(bots.ownerId, ownerId));

  return rows.map((r) => ({
    id: r.id,
    userId: r.userId,
    name: r.name,
    webhookUrl: r.webhookUrl,
    webhookSecret: r.webhookSecret,
    createdAt: r.createdAt.toISOString(),
  }));
}

export async function addBotToWorkspace(
  botId: string,
  workspaceId: string,
  callerId: string
) {
  // Verify bot exists
  const [bot] = await db
    .select({ userId: bots.userId, ownerId: bots.ownerId })
    .from(bots)
    .where(eq(bots.id, botId))
    .limit(1);

  if (!bot) {
    throw new ServiceError("Bot not found", 404);
  }

  // Caller must be a workspace member
  const [callerMembership] = await db
    .select()
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, callerId)
      )
    )
    .limit(1);

  if (!callerMembership) {
    throw new ServiceError("You are not a member of this workspace", 403);
  }

  // Add bot user as workspace member (idempotent)
  const [existingMember] = await db
    .select()
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, bot.userId)
      )
    )
    .limit(1);

  if (!existingMember) {
    await db.insert(workspaceMembers).values({
      workspaceId,
      userId: bot.userId,
      role: "member",
    });
  }

  // Add bot to all channels in the workspace
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
          eq(conversationParticipants.userId, bot.userId)
        )
      )
      .limit(1);

    if (!existingParticipant) {
      await db.insert(conversationParticipants).values({
        conversationId: channel.id,
        userId: bot.userId,
        role: "member",
      });
    }
  }

  return { success: true };
}

export async function removeBotFromWorkspace(
  botId: string,
  workspaceId: string,
  callerId: string
) {
  // Verify bot exists
  const [bot] = await db
    .select({ userId: bots.userId, ownerId: bots.ownerId })
    .from(bots)
    .where(eq(bots.id, botId))
    .limit(1);

  if (!bot) {
    throw new ServiceError("Bot not found", 404);
  }

  // Caller must be a workspace member
  const [callerMembership] = await db
    .select()
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, callerId)
      )
    )
    .limit(1);

  if (!callerMembership) {
    throw new ServiceError("You are not a member of this workspace", 403);
  }

  // Remove bot from all channels in the workspace
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
          eq(conversationParticipants.userId, bot.userId)
        )
      );
  }

  // Remove bot from workspace members
  await db
    .delete(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, bot.userId)
      )
    );

  return { success: true };
}

export async function regenerateBotKey(botId: string, ownerId: string) {
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
      "Only the bot owner can regenerate the API key",
      403
    );
  }

  const newApiKey = generateApiKey();
  await db.update(bots).set({ apiKey: newApiKey }).where(eq(bots.id, botId));

  return { apiKey: newApiKey };
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
