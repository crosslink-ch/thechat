import { Elysia } from "elysia";
import { z } from "zod";
import { resolveRequestUser } from "../auth/middleware";
import { browserAuthPolicy } from "../auth/browser";
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

export const hermesRoutes = new Elysia({ prefix: "/bots" })
  .use(browserAuthPolicy)
  .derive(async ({ headers }) => ({ user: await resolveRequestUser(headers) } as any))
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
