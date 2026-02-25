import { Elysia } from "elysia";
import { z } from "zod";
import { eq, and, ne } from "drizzle-orm";
import type { WsServerEvent } from "@thechat/shared";
import { resolveTokenToUser } from "../auth/middleware";
import { ServiceError } from "../services/errors";
import {
  createBot,
  listBots,
  getBot,
  updateBot,
  deleteBot,
  addBotToWorkspace,
  removeBotFromWorkspace,
  regenerateBotKey,
  regenerateBotSecret,
} from "../services/bots";
import { db } from "../db";
import { bots, users, workspaceMembers } from "../db/schema";
import { broadcastToUser } from "../ws";

const createSchema = z.object({
  name: z.string().trim().min(1, "Bot name is required"),
  webhookUrl: z.string().url().nullish(),
});

const updateSchema = z.object({
  name: z.string().trim().min(1, "Bot name is required").optional(),
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

    try {
      return await createBot(name, webhookUrl ?? null, user.id);
    } catch (e: any) {
      set.status = e instanceof ServiceError ? e.status : 500;
      return { error: e.message ?? "Unknown error" };
    }
  })

  // List bots owned by current user
  .get("/list", async ({ user, set }) => {
    try {
      return await listBots(user.id);
    } catch (e: any) {
      set.status = e instanceof ServiceError ? e.status : 500;
      return { error: e.message ?? "Unknown error" };
    }
  })

  // Get bot by ID (owner only)
  .get("/:botId", async ({ params, user, set }) => {
    try {
      return await getBot(params.botId, user.id);
    } catch (e: any) {
      set.status = e instanceof ServiceError ? e.status : 500;
      return { error: e.message ?? "Unknown error" };
    }
  })

  // Update bot (owner only)
  .patch("/:botId", async ({ params, body, user, set }) => {
    const parsed = updateSchema.safeParse(body);
    if (!parsed.success) {
      set.status = 400;
      return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
    }

    const updates: { name?: string; webhookUrl?: string | null } = {};
    if (parsed.data.name !== undefined) updates.name = parsed.data.name;
    if (parsed.data.webhookUrl !== undefined)
      updates.webhookUrl = parsed.data.webhookUrl ?? null;

    if (Object.keys(updates).length === 0) {
      set.status = 400;
      return { error: "No fields to update" };
    }

    try {
      return await updateBot(params.botId, user.id, updates);
    } catch (e: any) {
      set.status = e instanceof ServiceError ? e.status : 500;
      return { error: e.message ?? "Unknown error" };
    }
  })

  // Delete bot (owner only)
  .delete("/:botId", async ({ params, user, set }) => {
    try {
      return await deleteBot(params.botId, user.id);
    } catch (e: any) {
      set.status = e instanceof ServiceError ? e.status : 500;
      return { error: e.message ?? "Unknown error" };
    }
  })

  // Add bot to workspace
  .post("/:botId/workspaces", async ({ params, body, user, set }) => {
    const parsed = addToWorkspaceSchema.safeParse(body);
    if (!parsed.success) {
      set.status = 400;
      return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
    }

    try {
      const result = await addBotToWorkspace(
        params.botId,
        parsed.data.workspaceId,
        user.id
      );

      // Broadcast member_joined to existing workspace members
      const [botInfo] = await db
        .select({ userId: bots.userId, name: users.name })
        .from(bots)
        .innerJoin(users, eq(bots.userId, users.id))
        .where(eq(bots.id, params.botId))
        .limit(1);

      if (botInfo) {
        const members = await db
          .select({ userId: workspaceMembers.userId })
          .from(workspaceMembers)
          .where(
            and(
              eq(workspaceMembers.workspaceId, parsed.data.workspaceId),
              ne(workspaceMembers.userId, botInfo.userId)
            )
          );

        const event: WsServerEvent = {
          type: "member_joined",
          workspaceId: parsed.data.workspaceId,
          member: {
            userId: botInfo.userId,
            role: "member",
            joinedAt: new Date().toISOString(),
            user: {
              id: botInfo.userId,
              name: botInfo.name,
              email: null,
              avatar: null,
            },
          },
        };

        for (const m of members) {
          broadcastToUser(m.userId, event);
        }
      }

      return result;
    } catch (e: any) {
      set.status = e instanceof ServiceError ? e.status : 500;
      return { error: e.message ?? "Unknown error" };
    }
  })

  // Remove bot from workspace
  .delete("/:botId/workspaces/:workspaceId", async ({ params, user, set }) => {
    try {
      return await removeBotFromWorkspace(
        params.botId,
        params.workspaceId,
        user.id
      );
    } catch (e: any) {
      set.status = e instanceof ServiceError ? e.status : 500;
      return { error: e.message ?? "Unknown error" };
    }
  })

  // Regenerate API key (owner only)
  .post("/:botId/regenerate-key", async ({ params, user, set }) => {
    try {
      return await regenerateBotKey(params.botId, user.id);
    } catch (e: any) {
      set.status = e instanceof ServiceError ? e.status : 500;
      return { error: e.message ?? "Unknown error" };
    }
  })

  // Regenerate webhook secret (owner only)
  .post("/:botId/regenerate-secret", async ({ params, user, set }) => {
    try {
      return await regenerateBotSecret(params.botId, user.id);
    } catch (e: any) {
      set.status = e instanceof ServiceError ? e.status : 500;
      return { error: e.message ?? "Unknown error" };
    }
  });
