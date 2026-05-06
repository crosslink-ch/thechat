import { Elysia } from "elysia";
import { z } from "zod";
import { resolveTokenToUser } from "../auth/middleware";
import { ServiceError } from "../services/errors";
import {
  getHermesBotCapabilities,
  getHermesBotConfig,
  testHermesBot,
  updateHermesBotConfig,
} from "../services/hermes";

const modeSchema = z.enum(["run", "response"]);
const scopeSchema = z.enum(["channel", "thread", "workspace"]);

const updateSchema = z.object({
  baseUrl: z.string().url("Hermes base URL must be a URL").optional(),
  apiKey: z.string().min(1, "Hermes API key is required").optional(),
  defaultMode: modeSchema.optional(),
  defaultInstructions: z.string().nullish(),
  defaultSessionScope: scopeSchema.optional(),
});

export const hermesRoutes = new Elysia({ prefix: "/bots" })
  .derive(async ({ headers }) => {
    const authHeader = headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) return { user: null } as any;
    const user = await resolveTokenToUser(authHeader.slice(7));
    return { user } as any;
  })
  .onBeforeHandle(({ user, set }) => {
    if (!user) {
      set.status = 401;
      return { error: "Authentication required" };
    }
  })
  .get("/:botId/hermes", async ({ params, user, set }) => {
    try {
      return await getHermesBotConfig(params.botId, user.id);
    } catch (e: any) {
      set.status = e instanceof ServiceError ? e.status : 500;
      return { error: e.message ?? "Unknown error" };
    }
  })
  .patch("/:botId/hermes", async ({ params, body, user, set }) => {
    const parsed = updateSchema.safeParse(body);
    if (!parsed.success) {
      set.status = 400;
      return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
    }
    try {
      return await updateHermesBotConfig(params.botId, user.id, {
        baseUrl: parsed.data.baseUrl,
        apiKey: parsed.data.apiKey,
        defaultMode: parsed.data.defaultMode,
        defaultInstructions: parsed.data.defaultInstructions,
        defaultSessionScope: parsed.data.defaultSessionScope,
      });
    } catch (e: any) {
      set.status = e instanceof ServiceError ? e.status : 500;
      return { error: e.message ?? "Unknown error" };
    }
  })
  .post("/:botId/hermes/test", async ({ params, user, set }) => {
    try {
      return await testHermesBot(params.botId, user.id);
    } catch (e: any) {
      set.status = e instanceof ServiceError ? e.status : 500;
      return { error: e.message ?? "Unknown error" };
    }
  })
  .get("/:botId/hermes/capabilities", async ({ params, user, set }) => {
    try {
      return await getHermesBotCapabilities(params.botId, user.id);
    } catch (e: any) {
      set.status = e instanceof ServiceError ? e.status : 500;
      return { error: e.message ?? "Unknown error" };
    }
  });
