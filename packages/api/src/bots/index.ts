import { Elysia } from "elysia";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { workspaceMembers } from "../db/schema";
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

const createSchema = z.object({
  name: z.string().trim().min(1, "Bot name is required"),
  webhookUrl: z.string().url().nullish(),
  kind: z.enum(["webhook", "hermes"]).optional().default("webhook"),
  workspaceId: z.string().trim().min(1, "Workspace ID is required").optional(),
});

const updateSchema = z.object({
  name: z.string().trim().min(1, "Bot name is required").optional(),
  webhookUrl: z.string().url().nullish(),
});

const addToWorkspaceSchema = z.object({
  workspaceId: z.string().trim().min(1, "Workspace ID is required"),
});

async function requireWorkspaceAdmin(workspaceId: string, userId: string) {
  const [member] = await db
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)))
    .limit(1);
  if (!member) throw new ServiceError("You are not a member of this workspace", 403);
  if (!["admin", "owner"].includes(member.role)) {
    throw new ServiceError("Only workspace admins can connect Hermes bots", 403);
  }
}

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

    if (body && typeof body === "object" && "hermes" in (body as Record<string, unknown>)) {
      set.status = 400;
      return { error: "Hermes connection settings must be sent to /bots/:botId/hermes" };
    }

    const parsed = createSchema.safeParse(body);
    if (!parsed.success) {
      set.status = 400;
      return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
    }

    const { name, webhookUrl, kind, workspaceId } = parsed.data;

    try {
      if (kind === "hermes") {
        if (!workspaceId) {
          set.status = 400;
          return { error: "Workspace ID is required for Hermes bots" };
        }
        await requireWorkspaceAdmin(workspaceId, user.id);
        const bot = await createBot(name, null, user.id, "hermes");
        await addBotToWorkspace(bot.id, workspaceId, user.id);
        const { apiKey: _apiKey, webhookSecret: _webhookSecret, ...publicBot } = bot;
        return publicBot;
      }
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
      return await addBotToWorkspace(
        params.botId,
        parsed.data.workspaceId,
        user.id
      );
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
