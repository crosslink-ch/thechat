import { Elysia } from "elysia";
import { z } from "zod";
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
import { createHermesBot } from "../services/hermes";

const hermesConfigSchema = z.object({
  baseUrl: z.string().url("Hermes base URL must be a URL"),
  apiKey: z.string().min(1, "Hermes API key is required"),
  defaultMode: z.enum(["run", "response"]).optional(),
  defaultInstructions: z.string().nullish(),
  defaultSessionScope: z.enum(["channel", "thread", "workspace"]).optional(),
});

const createSchema = z.object({
  name: z.string().trim().min(1, "Bot name is required"),
  webhookUrl: z.string().url().nullish(),
  kind: z.enum(["webhook", "hermes"]).optional().default("webhook"),
  workspaceId: z.string().trim().min(1, "Workspace ID is required").optional(),
  hermes: hermesConfigSchema.optional(),
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

    const { name, webhookUrl, kind, workspaceId, hermes } = parsed.data;

    try {
      if (kind === "hermes") {
        if (!workspaceId) {
          set.status = 400;
          return { error: "Workspace ID is required for Hermes bots" };
        }
        if (!hermes) {
          set.status = 400;
          return { error: "Hermes configuration is required for Hermes bots" };
        }
        return await createHermesBot(
          {
            workspaceId,
            name,
            baseUrl: hermes.baseUrl,
            apiKey: hermes.apiKey,
            defaultMode: hermes.defaultMode,
            defaultInstructions: hermes.defaultInstructions ?? null,
            defaultSessionScope: hermes.defaultSessionScope,
          },
          user.id,
        );
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
