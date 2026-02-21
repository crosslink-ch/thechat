import { Elysia } from "elysia";
import { eq, and, gt } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import {
  workspaces,
  workspaceMembers,
  conversations,
  conversationParticipants,
  users,
  sessions,
} from "../db/schema";

function generateWorkspaceId(name: string): string {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .substring(0, 50);
  const suffix = Math.floor(10000 + Math.random() * 90000);
  return `${slug}-${suffix}`;
}

const createSchema = z.object({
  name: z.string().trim().min(1, "Workspace name is required"),
});

const joinSchema = z.object({
  workspaceId: z.string().trim().min(1, "Workspace ID is required"),
});

export const workspaceRoutes = new Elysia({ prefix: "/workspaces" })
  .derive(async ({ headers }) => {
    const authHeader = headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      return { user: null } as any;
    }

    const token = authHeader.slice(7);
    const [session] = await db
      .select()
      .from(sessions)
      .where(and(eq(sessions.token, token), gt(sessions.expiresAt, new Date())))
      .limit(1);

    if (!session) {
      return { user: null } as any;
    }

    const [user] = await db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        avatar: users.avatar,
      })
      .from(users)
      .where(eq(users.id, session.userId))
      .limit(1);

    if (!user) {
      return { user: null } as any;
    }

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

    const { name } = parsed.data;

    // Retry slug generation on collision (max 3 attempts)
    let id: string = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      id = generateWorkspaceId(name);
      const [existing] = await db
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(eq(workspaces.id, id))
        .limit(1);
      if (!existing) break;
      if (attempt === 2) {
        set.status = 500;
        return { error: "Failed to generate unique workspace ID" };
      }
    }

    // Create workspace
    const [workspace] = await db
      .insert(workspaces)
      .values({ id, name, createdById: user.id })
      .returning();

    // Add creator as owner
    await db.insert(workspaceMembers).values({
      workspaceId: id,
      userId: user.id,
      role: "owner",
    });

    // Create "General" channel (a conversation tied to the workspace)
    const [channel] = await db
      .insert(conversations)
      .values({
        title: "General",
        type: "group",
        workspaceId: id,
        name: "general",
      })
      .returning();

    // Add creator as participant of the General channel
    await db.insert(conversationParticipants).values({
      conversationId: channel.id,
      userId: user.id,
      role: "owner",
    });

    return {
      id: workspace.id,
      name: workspace.name,
      createdAt: workspace.createdAt.toISOString(),
      updatedAt: workspace.updatedAt.toISOString(),
    };
  })

  // Join workspace
  .post("/join", async ({ body, user, set }) => {
    const parsed = joinSchema.safeParse(body);
    if (!parsed.success) {
      set.status = 400;
      return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
    }

    const { workspaceId } = parsed.data;

    // Check workspace exists
    const [workspace] = await db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1);

    if (!workspace) {
      set.status = 404;
      return { error: "Workspace not found" };
    }

    // Check if already a member (idempotent)
    const [existingMember] = await db
      .select()
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.userId, user.id)
        )
      )
      .limit(1);

    if (!existingMember) {
      // Add as member
      await db.insert(workspaceMembers).values({
        workspaceId,
        userId: user.id,
        role: "member",
      });
    }

    // Add user to all existing channels in the workspace
    const channels = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.workspaceId, workspaceId));

    for (const channel of channels) {
      const [existingParticipant] = await db
        .select()
        .from(conversationParticipants)
        .where(
          and(
            eq(conversationParticipants.conversationId, channel.id),
            eq(conversationParticipants.userId, user.id)
          )
        )
        .limit(1);

      if (!existingParticipant) {
        await db.insert(conversationParticipants).values({
          conversationId: channel.id,
          userId: user.id,
          role: "member",
        });
      }
    }

    return { success: true };
  })

  // List my workspaces
  .get("/list", async ({ user }) => {
    const memberships = await db
      .select({
        workspaceId: workspaceMembers.workspaceId,
        role: workspaceMembers.role,
        id: workspaces.id,
        name: workspaces.name,
        createdAt: workspaces.createdAt,
        updatedAt: workspaces.updatedAt,
      })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id))
      .where(eq(workspaceMembers.userId, user.id));

    return memberships.map((m) => ({
      id: m.id,
      name: m.name,
      role: m.role,
      createdAt: m.createdAt.toISOString(),
      updatedAt: m.updatedAt.toISOString(),
    }));
  })

  // Get workspace detail
  .get("/:id", async ({ params, user, set }) => {
    const { id } = params;

    // Check membership
    const [membership] = await db
      .select()
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, id),
          eq(workspaceMembers.userId, user.id)
        )
      )
      .limit(1);

    if (!membership) {
      // Check if workspace exists at all
      const [workspace] = await db
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(eq(workspaces.id, id))
        .limit(1);

      if (!workspace) {
        set.status = 404;
        return { error: "Workspace not found" };
      }

      set.status = 403;
      return { error: "You are not a member of this workspace" };
    }

    // Get workspace
    const [workspace] = await db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, id))
      .limit(1);

    // Get members with user info
    const members = await db
      .select({
        userId: workspaceMembers.userId,
        role: workspaceMembers.role,
        joinedAt: workspaceMembers.joinedAt,
        userName: users.name,
        userEmail: users.email,
        userAvatar: users.avatar,
      })
      .from(workspaceMembers)
      .innerJoin(users, eq(workspaceMembers.userId, users.id))
      .where(eq(workspaceMembers.workspaceId, id));

    // Get channels
    const channels = await db
      .select()
      .from(conversations)
      .where(eq(conversations.workspaceId, id));

    return {
      id: workspace.id,
      name: workspace.name,
      createdAt: workspace.createdAt.toISOString(),
      updatedAt: workspace.updatedAt.toISOString(),
      members: members.map((m) => ({
        userId: m.userId,
        role: m.role,
        joinedAt: m.joinedAt.toISOString(),
        user: {
          id: m.userId,
          name: m.userName,
          email: m.userEmail,
          avatar: m.userAvatar,
        },
      })),
      channels: channels.map((c) => ({
        id: c.id,
        workspaceId: c.workspaceId,
        name: c.name,
        title: c.title,
        createdAt: c.createdAt.toISOString(),
        updatedAt: c.updatedAt.toISOString(),
      })),
    };
  });
