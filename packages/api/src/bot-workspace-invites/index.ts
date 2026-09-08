import { Elysia } from "elysia";
import { z } from "zod";
import { resolveRequestUser } from "../auth/middleware";
import { browserAuthPolicy } from "../auth/browser";
import { ServiceError } from "../services/errors";
import {
  acceptBotWorkspaceInvite,
  declineBotWorkspaceInvite,
  listOwnedPendingBotWorkspaceInvites,
} from "../services/bot-workspace-memberships";

const resolutionSchema = z.object({ inviteId: z.string().uuid() });

export const botWorkspaceInviteRoutes = new Elysia({
  prefix: "/bot-workspace-invites",
})
  .use(browserAuthPolicy)
  .derive(async ({ headers }) => ({ user: await resolveRequestUser(headers) } as any))
  .onBeforeHandle(({ user, set }) => {
    if (!user) {
      set.status = 401;
      return { error: "Authentication required" };
    }
  })
  .get("/pending", async ({ user, set }) => {
    try {
      return await listOwnedPendingBotWorkspaceInvites(user.id);
    } catch (error) {
      if (error instanceof ServiceError) {
        set.status = error.status;
        return { error: error.message };
      }
      throw error;
    }
  })
  .post("/accept", async ({ body, user, set }) => {
    const parsed = resolutionSchema.safeParse(body);
    if (!parsed.success) {
      set.status = 400;
      return { error: parsed.error.issues[0]?.message ?? "Invalid invite ID" };
    }

    try {
      return await acceptBotWorkspaceInvite(parsed.data.inviteId, user.id);
    } catch (error) {
      if (error instanceof ServiceError) {
        set.status = error.status;
        return { error: error.message };
      }
      throw error;
    }
  })
  .post("/decline", async ({ body, user, set }) => {
    const parsed = resolutionSchema.safeParse(body);
    if (!parsed.success) {
      set.status = 400;
      return { error: parsed.error.issues[0]?.message ?? "Invalid invite ID" };
    }

    try {
      return await declineBotWorkspaceInvite(parsed.data.inviteId, user.id);
    } catch (error) {
      if (error instanceof ServiceError) {
        set.status = error.status;
        return { error: error.message };
      }
      throw error;
    }
  });
