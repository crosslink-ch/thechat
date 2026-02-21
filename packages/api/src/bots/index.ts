import { Elysia } from "elysia";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import crypto from "crypto";
import { db } from "../db";
import {
  users,
  bots,
  workspaceMembers,
  conversations,
  conversationParticipants,
} from "../db/schema";
import { resolveTokenToUser } from "../auth/middleware";

function generateApiKey(): string {
  return `bot_${crypto.randomBytes(32).toString("hex")}`;
}

const createSchema = z.object({
  name: z.string().trim().min(1, "Bot name is required"),
  webhookUrl: z.string().url().nullish(),
});

const addToWorkspaceSchema = z.object({
  workspaceId: z.string().trim().min(1, "Workspace ID is required"),
});

export const botRoutes = new Elysia({ prefix: "/bots" })
  .derive(async ({ headers }) => {
    const authHeader = headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      return { user: null } as any;
    }

    const token = authHeader.slice(7);
    const user = await resolveTokenToUser(token);
    if (!user) return { user: null } as any;
    return { user };
  })
  .onBeforeHandle(({ user, set }) => {
    if (!user) {
      set.status = 401;
      return { error: "Authentication required" };
    }
  })

  // Create bot (human-only)
  .post("/create", async ({ body, user, set }) => {
    if (user.type === "bot") {
      set.status = 403;
      return { error: "Bots cannot create other bots" };
    }

    const parsed = createSchema.safeParse(body);
    if (!parsed.success) {
      set.status = 400;
      return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
    }

    const { name, webhookUrl } = parsed.data;
    const apiKey = generateApiKey();

    // Create the bot's user record
    const [botUser] = await db
      .insert(users)
      .values({
        name,
        type: "bot",
      })
      .returning({ id: users.id, name: users.name });

    // Create the bot record
    const [bot] = await db
      .insert(bots)
      .values({
        userId: botUser.id,
        ownerId: user.id,
        webhookUrl: webhookUrl ?? null,
        apiKey,
      })
      .returning();

    return {
      id: bot.id,
      userId: botUser.id,
      name: botUser.name,
      apiKey,
      webhookUrl: bot.webhookUrl,
      createdAt: bot.createdAt.toISOString(),
    };
  })

  // List bots owned by current user
  .get("/list", async ({ user }) => {
    const rows = await db
      .select({
        id: bots.id,
        userId: bots.userId,
        webhookUrl: bots.webhookUrl,
        createdAt: bots.createdAt,
        name: users.name,
      })
      .from(bots)
      .innerJoin(users, eq(bots.userId, users.id))
      .where(eq(bots.ownerId, user.id));

    return rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      name: r.name,
      webhookUrl: r.webhookUrl,
      createdAt: r.createdAt.toISOString(),
    }));
  })

  // Add bot to workspace
  .post("/:botId/workspaces", async ({ params, body, user, set }) => {
    const { botId } = params;

    const parsed = addToWorkspaceSchema.safeParse(body);
    if (!parsed.success) {
      set.status = 400;
      return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
    }

    const { workspaceId } = parsed.data;

    // Verify bot exists
    const [bot] = await db
      .select({ userId: bots.userId, ownerId: bots.ownerId })
      .from(bots)
      .where(eq(bots.id, botId))
      .limit(1);

    if (!bot) {
      set.status = 404;
      return { error: "Bot not found" };
    }

    // Caller must be a workspace member
    const [callerMembership] = await db
      .select()
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.userId, user.id)
        )
      )
      .limit(1);

    if (!callerMembership) {
      set.status = 403;
      return { error: "You are not a member of this workspace" };
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
  })

  // Remove bot from workspace
  .delete("/:botId/workspaces/:workspaceId", async ({ params, user, set }) => {
    const { botId, workspaceId } = params;

    // Verify bot exists
    const [bot] = await db
      .select({ userId: bots.userId, ownerId: bots.ownerId })
      .from(bots)
      .where(eq(bots.id, botId))
      .limit(1);

    if (!bot) {
      set.status = 404;
      return { error: "Bot not found" };
    }

    // Caller must be a workspace member
    const [callerMembership] = await db
      .select()
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.userId, user.id)
        )
      )
      .limit(1);

    if (!callerMembership) {
      set.status = 403;
      return { error: "You are not a member of this workspace" };
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
  })

  // Regenerate API key (owner only)
  .post("/:botId/regenerate-key", async ({ params, user, set }) => {
    const { botId } = params;

    const [bot] = await db
      .select({ id: bots.id, ownerId: bots.ownerId })
      .from(bots)
      .where(eq(bots.id, botId))
      .limit(1);

    if (!bot) {
      set.status = 404;
      return { error: "Bot not found" };
    }

    if (bot.ownerId !== user.id) {
      set.status = 403;
      return { error: "Only the bot owner can regenerate the API key" };
    }

    const newApiKey = generateApiKey();
    await db.update(bots).set({ apiKey: newApiKey }).where(eq(bots.id, botId));

    return { apiKey: newApiKey };
  });
