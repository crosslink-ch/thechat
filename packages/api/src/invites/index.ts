import { Elysia } from "elysia";
import { z } from "zod";

import { resolveRequestUser } from "../auth/middleware";
import { browserAuthPolicy } from "../auth/browser";
import { ServiceError } from "../services/errors";
import {
  createInvite,
  listPendingInvites,
  acceptInvite,
  declineInvite,
} from "../services/invites";


const createInviteSchema = z.object({
  workspaceId: z.string().trim().min(1, "Workspace ID is required"),
  email: z.string().email("Valid email is required"),
});

const inviteActionSchema = z.object({
  inviteId: z.string().uuid("Valid invite ID is required"),
});

export const inviteRoutes = new Elysia({ prefix: "/invites" })
  .use(browserAuthPolicy)
  .derive(async ({ headers }) => ({ user: await resolveRequestUser(headers) } as any))
  .onBeforeHandle(({ user, set }) => {
    if (!user) {
      set.status = 401;
      return { error: "Authentication required" };
    }
  })

  // Create invite
  .post("/create", async ({ body, user, set }) => {
    const parsed = createInviteSchema.safeParse(body);
    if (!parsed.success) {
      set.status = 400;
      return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
    }

    try {
      const invite = await createInvite(
        parsed.data.workspaceId,
        user.id,
        parsed.data.email
      );

      return invite;
    } catch (e) {
      if (e instanceof ServiceError) {
        set.status = e.status;
        return { error: e.message };
      }
      throw e;
    }
  })

  // List pending invites
  .get("/pending", async ({ user }) => {
    return await listPendingInvites(user.id);
  })

  // Accept invite
  .post("/accept", async ({ body, user, set }) => {
    const parsed = inviteActionSchema.safeParse(body);
    if (!parsed.success) {
      set.status = 400;
      return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
    }

    try {
      return await acceptInvite(parsed.data.inviteId, user.id);
    } catch (e) {
      if (e instanceof ServiceError) {
        set.status = e.status;
        return { error: e.message };
      }
      throw e;
    }
  })

  // Decline invite
  .post("/decline", async ({ body, user, set }) => {
    const parsed = inviteActionSchema.safeParse(body);
    if (!parsed.success) {
      set.status = 400;
      return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
    }

    try {
      await declineInvite(parsed.data.inviteId, user.id);
      return { success: true };
    } catch (e) {
      if (e instanceof ServiceError) {
        set.status = e.status;
        return { error: e.message };
      }
      throw e;
    }
  });
