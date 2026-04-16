import { Elysia } from "elysia";
import { z } from "zod";
import { resolveTokenToUser } from "../auth/middleware";
import { ServiceError } from "../services/errors";
import {
  getWorkspaceConfig,
  setOpenRouterConfig,
  setGlmConfig,
  setFeatherlessConfig,
  setActiveProvider,
  updateWorkspaceSettings,
  deleteWorkspaceConfig,
} from "../services/workspace-config";

const openrouterSchema = z.object({
  apiKey: z.string().min(1, "API key is required"),
});

const glmSchema = z.object({
  apiKey: z.string().min(1, "API key is required"),
});

const featherlessSchema = z.object({
  apiKey: z.string().min(1, "API key is required"),
});

const providerSchema = z.object({
  provider: z.enum(["openrouter", "codex", "glm", "featherless"]),
});

const settingsSchema = z.object({
  openrouterModel: z.string().nullable().optional(),
  codexModel: z.string().nullable().optional(),
  glmModel: z.string().nullable().optional(),
  featherlessModel: z.string().nullable().optional(),
  reasoningEffort: z.enum(["low", "medium", "high", "xhigh"]).nullable().optional(),
});

export const workspaceConfigRoutes = new Elysia({
  prefix: "/workspaces",
})
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

  // Get workspace config
  .get("/:id/config", async ({ params, user, set }) => {
    try {
      return await getWorkspaceConfig(params.id, user.id);
    } catch (e) {
      if (e instanceof ServiceError) {
        set.status = e.status;
        return { error: e.message };
      }
      throw e;
    }
  })

  // Set OpenRouter API key
  .put("/:id/config/openrouter", async ({ params, body, user, set }) => {
    const parsed = openrouterSchema.safeParse(body);
    if (!parsed.success) {
      set.status = 400;
      return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
    }

    try {
      return await setOpenRouterConfig(params.id, user.id, parsed.data.apiKey);
    } catch (e) {
      if (e instanceof ServiceError) {
        set.status = e.status;
        return { error: e.message };
      }
      throw e;
    }
  })

  // Set GLM API key
  .put("/:id/config/glm", async ({ params, body, user, set }) => {
    const parsed = glmSchema.safeParse(body);
    if (!parsed.success) {
      set.status = 400;
      return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
    }

    try {
      return await setGlmConfig(params.id, user.id, parsed.data.apiKey);
    } catch (e) {
      if (e instanceof ServiceError) {
        set.status = e.status;
        return { error: e.message };
      }
      throw e;
    }
  })

  // Set Featherless API key
  .put("/:id/config/featherless", async ({ params, body, user, set }) => {
    const parsed = featherlessSchema.safeParse(body);
    if (!parsed.success) {
      set.status = 400;
      return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
    }

    try {
      return await setFeatherlessConfig(params.id, user.id, parsed.data.apiKey);
    } catch (e) {
      if (e instanceof ServiceError) {
        set.status = e.status;
        return { error: e.message };
      }
      throw e;
    }
  })

  // Set active provider
  .put("/:id/config/provider", async ({ params, body, user, set }) => {
    const parsed = providerSchema.safeParse(body);
    if (!parsed.success) {
      set.status = 400;
      return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
    }

    try {
      return await setActiveProvider(params.id, user.id, parsed.data.provider);
    } catch (e) {
      if (e instanceof ServiceError) {
        set.status = e.status;
        return { error: e.message };
      }
      throw e;
    }
  })

  // Update model/reasoning settings
  .put("/:id/config/settings", async ({ params, body, user, set }) => {
    const parsed = settingsSchema.safeParse(body);
    if (!parsed.success) {
      set.status = 400;
      return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
    }

    try {
      return await updateWorkspaceSettings(params.id, user.id, parsed.data);
    } catch (e) {
      if (e instanceof ServiceError) {
        set.status = e.status;
        return { error: e.message };
      }
      throw e;
    }
  })

  // Delete workspace config
  .delete("/:id/config", async ({ params, user, set }) => {
    try {
      await deleteWorkspaceConfig(params.id, user.id);
      return { success: true };
    } catch (e) {
      if (e instanceof ServiceError) {
        set.status = e.status;
        return { error: e.message };
      }
      throw e;
    }
  });
