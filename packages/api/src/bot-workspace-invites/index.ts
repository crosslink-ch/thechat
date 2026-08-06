import { Elysia } from "elysia";
import { z } from "zod";
import { resolveTokenToUser } from "../auth/middleware";
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
  .derive(async ({ headers }) => {
    const authHeader = headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      return { user: null } as any;
    }

    const user = await resolveTokenToUser(authHeader.slice(7));
    return { user: user ?? null } as any;
  })
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
