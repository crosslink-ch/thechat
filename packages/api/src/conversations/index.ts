import { Elysia } from "elysia";
import { z } from "zod";
import { resolveTokenToUser } from "../auth/middleware";
import { ServiceError } from "../services/errors";
import {
  createOrGetDm,
  listUserDms,
  createChannel,
} from "../services/conversations";

const dmSchema = z.object({
  workspaceId: z.string().trim().min(1),
  otherUserId: z.string().uuid(),
});

const channelSchema = z.object({
  workspaceId: z.string().trim().min(1),
  name: z.string().trim().min(1).max(100),
});

export const conversationRoutes = new Elysia({ prefix: "/conversations" })
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

  // Create or get existing DM between two users in a workspace
  .post("/dm", async ({ body, user, set }) => {
    const parsed = dmSchema.safeParse(body);
    if (!parsed.success) {
      set.status = 400;
      return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
    }

    try {
      return await createOrGetDm(
        parsed.data.workspaceId,
        user.id,
        parsed.data.otherUserId
      );
    } catch (e) {
      if (e instanceof ServiceError) {
        set.status = e.status;
        return { error: e.message };
      }
      throw e;
    }
  })

  // Create a new channel
  .post("/channel", async ({ body, user, set }) => {
    const parsed = channelSchema.safeParse(body);
    if (!parsed.success) {
      set.status = 400;
      return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
    }

    try {
      return await createChannel(
        parsed.data.workspaceId,
        parsed.data.name,
        user.id
      );
    } catch (e) {
      if (e instanceof ServiceError) {
        set.status = e.status;
        return { error: e.message };
      }
      throw e;
    }
  })

  // List DM conversations for current user in a workspace
  .get("/:workspaceId/dms", async ({ params, user, set }) => {
    try {
      return await listUserDms(params.workspaceId, user.id);
    } catch (e) {
      if (e instanceof ServiceError) {
        set.status = e.status;
        return { error: e.message };
      }
      throw e;
    }
  });
