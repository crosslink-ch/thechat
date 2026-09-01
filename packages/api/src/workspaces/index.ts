import { Elysia } from "elysia";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { resolveTokenToUser } from "../auth/middleware";
import { ServiceError } from "../services/errors";
import {
  listUserWorkspaces,
  getWorkspaceDetail,
  createWorkspace,
  updateMemberRole,
  removeMember,
} from "../services/workspaces";
import {
  cancelBotWorkspaceInvite,
  listWorkspaceBotInvites,
  removeBotWorkspaceMembership,
  requestBotForWorkspace,
} from "../services/bot-workspace-memberships";
import {
  listPendingWorkspaceInvites,
  revokeWorkspaceInvite,
} from "../services/invites";
import { broadcastToUser } from "../ws";
import { db } from "../db";
import { workspaceMembers } from "../db/schema";
import type { WsServerEvent, WorkspaceMemberRole } from "@thechat/shared";

const createSchema = z.object({
  name: z.string().trim().min(1, "Workspace name is required"),
});

export const workspaceRoutes = new Elysia({ prefix: "/workspaces" })
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

  // Create workspace
  .post("/create", async ({ body, user, set }) => {
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) {
      set.status = 400;
      return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
    }

    try {
      return await createWorkspace(parsed.data.name, user.id);
    } catch (e) {
      if (e instanceof ServiceError) {
        set.status = e.status;
        return { error: e.message };
      }
      throw e;
    }
  })

  // List my workspaces
  .get("/list", async ({ user }) => {
    return await listUserWorkspaces(user.id);
  })

  // Get workspace detail
  .get("/:id", async ({ params, user, set }) => {
    try {
      return await getWorkspaceDetail(params.id, user.id);
    } catch (e) {
      if (e instanceof ServiceError) {
        set.status = e.status;
        return { error: e.message };
      }
      throw e;
    }
  })

  // Add a bot directly when it belongs to the caller, otherwise request approval.
  .post("/:id/bots", async ({ params, body, user, set }) => {
    const parsed = z.object({ botId: z.string().uuid() }).safeParse(body);
    if (!parsed.success) {
      set.status = 400;
      return { error: parsed.error.issues[0]?.message ?? "Invalid bot ID" };
    }

    try {
      return await requestBotForWorkspace(params.id, parsed.data.botId, user.id);
    } catch (e) {
      if (e instanceof ServiceError) {
        set.status = e.status;
        return { error: e.message };
      }
      throw e;
    }
  })

  // List outstanding people invitations for workspace admins.
  .get("/:id/invites", async ({ params, user, set }) => {
    try {
      return await listPendingWorkspaceInvites(params.id, user.id);
    } catch (e) {
      if (e instanceof ServiceError) {
        set.status = e.status;
        return { error: e.message };
      }
      throw e;
    }
  })

  // Revoke an outstanding people invitation.
  .delete("/:id/invites/:inviteId", async ({ params, user, set }) => {
    try {
      return await revokeWorkspaceInvite(params.id, params.inviteId, user.id);
    } catch (e) {
      if (e instanceof ServiceError) {
        set.status = e.status;
        return { error: e.message };
      }
      throw e;
    }
  })

  // List approval requests initiated by workspace admins.
  .get("/:id/bot-invites", async ({ params, user, set }) => {
    try {
      return await listWorkspaceBotInvites(params.id, user.id);
    } catch (e) {
      if (e instanceof ServiceError) {
        set.status = e.status;
        return { error: e.message };
      }
      throw e;
    }
  })

  // Cancel a pending bot approval request.
  .delete("/:id/bot-invites/:inviteId", async ({ params, user, set }) => {
    try {
      return await cancelBotWorkspaceInvite(
        params.id,
        params.inviteId,
        user.id,
      );
    } catch (e) {
      if (e instanceof ServiceError) {
        set.status = e.status;
        return { error: e.message };
      }
      throw e;
    }
  })

  // Remove a bot from this workspace. Bot owners and workspace admins may do so.
  .delete("/:id/bots/:botId", async ({ params, user, set }) => {
    try {
      return await removeBotWorkspaceMembership(
        params.botId,
        params.id,
        user.id,
      );
    } catch (e) {
      if (e instanceof ServiceError) {
        set.status = e.status;
        return { error: e.message };
      }
      throw e;
    }
  })

  // Change member role
  .post("/:id/members/:userId/role", async ({ params, body, user, set }) => {
    const parsed = z
      .object({ role: z.enum(["member", "admin"]) })
      .safeParse(body);
    if (!parsed.success) {
      set.status = 400;
      return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
    }

    try {
      const result = await updateMemberRole(
        params.id,
        user.id,
        params.userId,
        parsed.data.role
      );

      // Broadcast to all workspace members
      const members = await db
        .select({ userId: workspaceMembers.userId })
        .from(workspaceMembers)
        .where(eq(workspaceMembers.workspaceId, params.id));

      const event: WsServerEvent = {
        type: "member_role_changed",
        workspaceId: params.id,
        userId: params.userId,
        newRole: parsed.data.role as WorkspaceMemberRole,
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

  // Remove member
  .delete("/:id/members/:userId", async ({ params, user, set }) => {
    try {
      // Get all members before removal (so we can broadcast to removed user too)
      const membersBefore = await db
        .select({ userId: workspaceMembers.userId })
        .from(workspaceMembers)
        .where(eq(workspaceMembers.workspaceId, params.id));

      const result = await removeMember(params.id, user.id, params.userId);

      // Broadcast to all workspace members including the removed user
      const event: WsServerEvent = {
        type: "member_removed",
        workspaceId: params.id,
        userId: params.userId,
      };

      for (const m of membersBefore) {
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
  });
