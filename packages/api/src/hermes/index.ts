import { Elysia } from "elysia";
import { API_TAGS } from "../openapi-metadata";
import { jsonBodyDocumentation } from "../openapi-route";
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

export const hermesBotUpdateSchema = z.object({
  defaultMode: modeSchema.optional(),
}).strict();

export const hermesRoutes = new Elysia({
  prefix: "/bots",
  tags: [API_TAGS.hermes],
})
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
    const parsed = hermesBotUpdateSchema.safeParse(body);
    if (!parsed.success) {
      set.status = 400;
      return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
    }
    try {
      return await updateHermesBotConfig(params.botId, user.id, {
        defaultMode: parsed.data.defaultMode,
      });
    } catch (e: any) {
      set.status = e instanceof ServiceError ? e.status : 500;
      return { error: e.message ?? "Unknown error" };
    }
    },
    {
      detail: jsonBodyDocumentation(
        "Update Hermes bot settings",
        hermesBotUpdateSchema,
      ),
    },
  )
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
