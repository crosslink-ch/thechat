import { Elysia } from "elysia";
import { z } from "zod";
import { resolveTokenToUser } from "../auth/middleware";
import { ServiceError } from "../services/errors";
import {
  createBot,
  createHermesBotInWorkspace,
  listBots,
  getBot,
  updateBot,
  deleteBot,
  regenerateBotKey,
  revokeBotKey,
  regenerateBotSecret,
  updateAuthenticatedBotWebhook,
  updateAuthenticatedBotCommands,
} from "../services/bots";
import {
  addOwnedBotToWorkspace,
  removeBotWorkspaceMembership,
} from "../services/bot-workspace-memberships";

const createSchema = z.object({
  name: z.string().trim().min(1, "Bot name is required"),
  webhookUrl: z.string().url().nullish(),
  kind: z.enum(["webhook", "hermes", "hermes-rpc"]).optional().default("webhook"),
  attachmentAccess: z.boolean().optional().default(true),
  workspaceId: z.string().trim().min(1, "Workspace ID is required").optional(),
  hermesRpc: z.object({
    endpoint: z.string().trim().min(1, "Hermes RPC endpoint is required"),
    gatewayToken: z.string().trim().max(4096).nullable().optional(),
  }).strict().optional(),
});

const updateSchema = z.object({
  name: z.string().trim().min(1, "Bot name is required").optional(),
  webhookUrl: z.string().url().nullish(),
  attachmentAccess: z.boolean().optional(),
});

const registerWebhookSchema = z.object({
  url: z.string().url(),
});

const commandNameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    /^[a-z0-9][a-z0-9_-]{0,31}$/,
    "Command names must be 1-32 chars: lowercase letters, digits, '_' or '-'",
  );

const registerCommandsSchema = z.object({
  commands: z
    .array(
      z.object({
        command: commandNameSchema,
        description: z.string().trim().min(1).max(256),
        argsHint: z.string().trim().max(128).nullish(),
        category: z.string().trim().max(64).nullish(),
        aliases: z.array(commandNameSchema).max(8).optional(),
      }),
    )
    .max(200),
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

    if (body && typeof body === "object" && "hermes" in (body as Record<string, unknown>)) {
      set.status = 400;
      return { error: "Hermes connection settings must be sent to /bots/:botId/hermes" };
    }

    const parsed = createSchema.safeParse(body);
    if (!parsed.success) {
      set.status = 400;
      return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
    }

    const { name, webhookUrl, kind, attachmentAccess, workspaceId, hermesRpc } = parsed.data;

    try {
      if (kind === "hermes" || kind === "hermes-rpc") {
        if (!workspaceId) {
          set.status = 400;
          return { error: "Workspace ID is required for Hermes bots" };
        }
        if (kind === "hermes-rpc" && !hermesRpc) {
          set.status = 400;
          return { error: "Hermes RPC connection settings are required" };
        }
        if (kind === "hermes" && hermesRpc) {
          set.status = 400;
          return { error: "Hermes RPC settings are only valid for Hermes RPC bots" };
        }
        const bot = await createHermesBotInWorkspace(
          name,
          webhookUrl ?? null,
          user.id,
          workspaceId,
          attachmentAccess,
          kind === "hermes-rpc"
            ? { kind, hermesRpc }
            : undefined,
        );
        if (kind === "hermes-rpc") {
          const {
            webhookSecret: _webhookSecret,
            apiKey: _apiKey,
            ...publicBot
          } = bot;
          return publicBot;
        }
        const { webhookSecret: _webhookSecret, ...publicBot } = bot;
        return publicBot;
      }
      return await createBot(
        name,
        webhookUrl ?? null,
        user.id,
        kind,
        attachmentAccess,
      );
    } catch (e: any) {
      set.status = e instanceof ServiceError ? e.status : 500;
      return { error: e.message ?? "Unknown error" };
    }
  })

  // Register authenticated bot's webhook URL (bot-token only)
  .post("/me/webhook", async ({ body, user, set }) => {
    if (user.type !== "bot") {
      set.status = 403;
      return { error: "Only bots can register their own webhook" };
    }

    const parsed = registerWebhookSchema.safeParse(body);
    if (!parsed.success) {
      set.status = 400;
      return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
    }

    try {
      return await updateAuthenticatedBotWebhook(user.id, parsed.data.url);
    } catch (e: any) {
      set.status = e instanceof ServiceError ? e.status : 500;
      return { error: e.message ?? "Unknown error" };
    }
  })

  // Clear authenticated bot's webhook URL (bot-token only)
  .delete("/me/webhook", async ({ user, set }) => {
    if (user.type !== "bot") {
      set.status = 403;
      return { error: "Only bots can clear their own webhook" };
    }

    try {
      return await updateAuthenticatedBotWebhook(user.id, null);
    } catch (e: any) {
      set.status = e instanceof ServiceError ? e.status : 500;
      return { error: e.message ?? "Unknown error" };
    }
  })

  // Replace authenticated bot's slash command list (bot-token only, Telegram setMyCommands-style)
  .post("/me/commands", async ({ body, user, set }) => {
    if (user.type !== "bot") {
      set.status = 403;
      return { error: "Only bots can register their own commands" };
    }

    const parsed = registerCommandsSchema.safeParse(body);
    if (!parsed.success) {
      set.status = 400;
      return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
    }

    try {
      return await updateAuthenticatedBotCommands(user.id, parsed.data.commands);
    } catch (e: any) {
      set.status = e instanceof ServiceError ? e.status : 500;
      return { error: e.message ?? "Unknown error" };
    }
  })

  // Clear authenticated bot's slash command list (bot-token only)
  .delete("/me/commands", async ({ user, set }) => {
    if (user.type !== "bot") {
      set.status = 403;
      return { error: "Only bots can clear their own commands" };
    }

    try {
      return await updateAuthenticatedBotCommands(user.id, null);
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

    const updates: {
      name?: string;
      webhookUrl?: string | null;
      attachmentAccess?: boolean;
    } = {};
    if (parsed.data.name !== undefined) updates.name = parsed.data.name;
    if (parsed.data.webhookUrl !== undefined)
      updates.webhookUrl = parsed.data.webhookUrl ?? null;
    if (parsed.data.attachmentAccess !== undefined)
      updates.attachmentAccess = parsed.data.attachmentAccess;

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
      return await addOwnedBotToWorkspace(
        params.botId,
        parsed.data.workspaceId,
        user.id,
      );
    } catch (e: any) {
      set.status =
        e instanceof ServiceError
          ? e.status
          : 500;
      return { error: e.message ?? "Unknown error" };
    }
  })

  // Remove bot from workspace
  .delete("/:botId/workspaces/:workspaceId", async ({ params, user, set }) => {
    try {
      return await removeBotWorkspaceMembership(
        params.botId,
        params.workspaceId,
        user.id,
      );
    } catch (e: any) {
      set.status =
        e instanceof ServiceError
          ? e.status
          : 500;
      return { error: e.message ?? "Unknown error" };
    }
  })

  // Revoke API key without deleting the bot (owner only)
  .delete("/:botId/api-key", async ({ params, user, set }) => {
    try {
      return await revokeBotKey(params.botId, user.id);
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
