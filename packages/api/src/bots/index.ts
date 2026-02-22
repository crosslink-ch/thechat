import { Elysia } from "elysia";
import { z } from "zod";
import { resolveTokenToUser } from "../auth/middleware";
import { ServiceError } from "../services/errors";
import {
  createBot,
  listBots,
  addBotToWorkspace,
  removeBotFromWorkspace,
  regenerateBotKey,
  regenerateBotSecret,
} from "../services/bots";

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
