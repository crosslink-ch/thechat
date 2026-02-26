import { Elysia } from "elysia";
import { z } from "zod";
import { eq, and, ne } from "drizzle-orm";
import { resolveTokenToUser } from "../auth/middleware";
import { ServiceError } from "../services/errors";
import {
  createInvite,
  listPendingInvites,
  acceptInvite,
  declineInvite,
} from "../services/invites";
import { broadcastToUser } from "../ws";
import { db } from "../db";
import { workspaceMembers } from "../db/schema";
import type { WsServerEvent } from "@thechat/shared";

const createInviteSchema = z.object({
  workspaceId: z.string().trim().min(1, "Workspace ID is required"),
  email: z.string().email("Valid email is required"),
});

const inviteActionSchema = z.object({
  inviteId: z.string().uuid("Valid invite ID is required"),
});

export const inviteRoutes = new Elysia({ prefix: "/invites" })
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

      // Broadcast invite_received to invitee via WebSocket
      const event: WsServerEvent = {
        type: "invite_received",
        invite,
      };

      broadcastToUser(invite.inviteeId, event);

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
      const result = await acceptInvite(parsed.data.inviteId, user.id);

      // Broadcast member_joined to existing workspace members
      const members = await db
        .select({ userId: workspaceMembers.userId })
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, result.workspaceId),
            ne(workspaceMembers.userId, user.id)
          )
        );

      const event: WsServerEvent = {
        type: "member_joined",
        workspaceId: result.workspaceId,
        member: {
          userId: user.id,
          role: "member",
          joinedAt: new Date().toISOString(),
          user: {
            id: user.id,
            name: user.name,
            email: user.email,
            avatar: user.avatar,
            type: user.type,
          },
        },
      };

      for (const m of members) {
        broadcastToUser(m.userId, event);
      }

      return result;
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
