import { z } from "zod";
import { eq, and, lt, desc } from "drizzle-orm";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { db } from "../db";
import {
  users,
  workspaces,
  workspaceMembers,
  conversations,
  conversationParticipants,
  messages,
} from "../db/schema";
import { processMessageMentions } from "../bots/webhooks";
import type { McpUser } from "./auth";

function getUser(extra: { authInfo?: unknown }): McpUser {
  const user = extra.authInfo as McpUser | undefined;
  if (!user) throw new Error("Not authenticated");
  return user;
}

function text(value: unknown) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(value, null, 2) },
    ],
  };
}

function error(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

export function registerTools(server: McpServer) {
  // --- get_me ---
  server.registerTool(
    "get_me",
    { description: "Get the authenticated user's profile", inputSchema: {} },
    async (_args, extra) => {
      const user = getUser(extra);
      return text({
        id: user.id,
        name: user.name,
        email: user.email,
        avatar: user.avatar,
        type: user.type,
      });
    }
  );

  // --- list_workspaces ---
  server.registerTool(
    "list_workspaces",
    { description: "List workspaces the user belongs to", inputSchema: {} },
    async (_args, extra) => {
      const user = getUser(extra);

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

      return text(
        memberships.map((m) => ({
          id: m.id,
          name: m.name,
          role: m.role,
          createdAt: m.createdAt.toISOString(),
          updatedAt: m.updatedAt.toISOString(),
        }))
      );
    }
  );

  // --- get_workspace ---
  server.registerTool(
    "get_workspace",
    {
      description:
        "Get workspace details including members and channels. User must be a member.",
      inputSchema: {
        workspaceId: z.string().describe("The workspace ID (slug)"),
      },
    },
    async ({ workspaceId }, extra) => {
      const user = getUser(extra);

      // Check membership
      const [membership] = await db
        .select()
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, workspaceId),
            eq(workspaceMembers.userId, user.id)
          )
        )
        .limit(1);

      if (!membership) {
        return error("Not a member of this workspace");
      }

      const [workspace] = await db
        .select()
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId))
        .limit(1);

      if (!workspace) {
        return error("Workspace not found");
      }

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
        .where(eq(workspaceMembers.workspaceId, workspaceId));

      const channels = await db
        .select()
        .from(conversations)
        .where(eq(conversations.workspaceId, workspaceId));

      return text({
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
      });
    }
  );

  // --- create_workspace ---
  server.registerTool(
    "create_workspace",
    {
      description: "Create a new workspace. The creator becomes the owner.",
      inputSchema: {
        name: z.string().min(1).describe("Workspace name"),
      },
    },
    async ({ name }, extra) => {
      const user = getUser(extra);

      const slug = (name as string)
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9\s-]/g, "")
        .replace(/\s+/g, "-")
        .replace(/-+/g, "-")
        .substring(0, 50);
      const suffix = Math.floor(10000 + Math.random() * 90000);
      const id = `${slug}-${suffix}`;

      const [workspace] = await db
        .insert(workspaces)
        .values({ id, name: name as string, createdById: user.id })
        .returning();

      await db.insert(workspaceMembers).values({
        workspaceId: id,
        userId: user.id,
        role: "owner",
      });

      // Create default "General" channel
      const [channel] = await db
        .insert(conversations)
        .values({
          title: "General",
          type: "group",
          workspaceId: id,
          name: "general",
        })
        .returning();

      await db.insert(conversationParticipants).values({
        conversationId: channel.id,
        userId: user.id,
        role: "owner",
      });

      return text({
        id: workspace.id,
        name: workspace.name,
        createdAt: workspace.createdAt.toISOString(),
        updatedAt: workspace.updatedAt.toISOString(),
      });
    }
  );

  // --- join_workspace ---
  server.registerTool(
    "join_workspace",
    {
      description:
        "Join an existing workspace. Idempotent — safe to call if already a member.",
      inputSchema: {
        workspaceId: z.string().min(1).describe("The workspace ID to join"),
      },
    },
    async ({ workspaceId }, extra) => {
      const user = getUser(extra);

      const [workspace] = await db
        .select()
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId as string))
        .limit(1);

      if (!workspace) {
        return error("Workspace not found");
      }

      // Check if already a member
      const [existing] = await db
        .select()
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, workspaceId as string),
            eq(workspaceMembers.userId, user.id)
          )
        )
        .limit(1);

      if (!existing) {
        await db.insert(workspaceMembers).values({
          workspaceId: workspaceId as string,
          userId: user.id,
          role: "member",
        });
      }

      // Add to all existing channels
      const channels = await db
        .select({ id: conversations.id })
        .from(conversations)
        .where(eq(conversations.workspaceId, workspaceId as string));

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

      return text({ success: true });
    }
  );

  // --- list_dms ---
  server.registerTool(
    "list_dms",
    {
      description:
        "List DM conversations for the current user in a workspace, including the other user and last message.",
      inputSchema: {
        workspaceId: z.string().min(1).describe("The workspace ID"),
      },
    },
    async ({ workspaceId }, extra) => {
      const user = getUser(extra);

      // Check workspace membership
      const [membership] = await db
        .select()
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, workspaceId as string),
            eq(workspaceMembers.userId, user.id)
          )
        )
        .limit(1);

      if (!membership) {
        return error("Not a member of this workspace");
      }

      const myParticipations = await db
        .select({
          conversationId: conversationParticipants.conversationId,
        })
        .from(conversationParticipants)
        .where(eq(conversationParticipants.userId, user.id));

      const results = [];

      for (const { conversationId } of myParticipations) {
        const [conv] = await db
          .select()
          .from(conversations)
          .where(
            and(
              eq(conversations.id, conversationId),
              eq(conversations.type, "direct"),
              eq(conversations.workspaceId, workspaceId as string)
            )
          )
          .limit(1);

        if (!conv) continue;

        const otherParticipants = await db
          .select({ userId: conversationParticipants.userId })
          .from(conversationParticipants)
          .where(eq(conversationParticipants.conversationId, conversationId));

        const otherUserId = otherParticipants.find(
          (p) => p.userId !== user.id
        )?.userId;
        if (!otherUserId) continue;

        const [otherUser] = await db
          .select({
            id: users.id,
            name: users.name,
            email: users.email,
            avatar: users.avatar,
          })
          .from(users)
          .where(eq(users.id, otherUserId))
          .limit(1);

        if (!otherUser) continue;

        const [lastMsg] = await db
          .select({
            id: messages.id,
            conversationId: messages.conversationId,
            senderId: messages.senderId,
            content: messages.content,
            createdAt: messages.createdAt,
            senderName: users.name,
          })
          .from(messages)
          .innerJoin(users, eq(messages.senderId, users.id))
          .where(eq(messages.conversationId, conversationId))
          .orderBy(desc(messages.createdAt))
          .limit(1);

        results.push({
          id: conv.id,
          otherUser,
          lastMessage: lastMsg
            ? {
                id: lastMsg.id,
                conversationId: lastMsg.conversationId,
                senderId: lastMsg.senderId,
                senderName: lastMsg.senderName,
                content: lastMsg.content,
                createdAt: lastMsg.createdAt.toISOString(),
              }
            : null,
        });
      }

      return text(results);
    }
  );

  // --- create_channel ---
  server.registerTool(
    "create_channel",
    {
      description:
        "Create a new channel (group conversation) in a workspace. All workspace members are added automatically.",
      inputSchema: {
        workspaceId: z.string().min(1).describe("The workspace ID"),
        name: z
          .string()
          .min(1)
          .max(100)
          .describe("Channel name (will be slugified)"),
      },
    },
    async ({ workspaceId, name }, extra) => {
      const user = getUser(extra);

      // Check workspace membership
      const [membership] = await db
        .select()
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, workspaceId as string),
            eq(workspaceMembers.userId, user.id)
          )
        )
        .limit(1);

      if (!membership) {
        return error("Not a member of this workspace");
      }

      const slug = (name as string)
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, "")
        .replace(/\s+/g, "-");

      const [channel] = await db
        .insert(conversations)
        .values({
          title: name as string,
          type: "group",
          workspaceId: workspaceId as string,
          name: slug,
        })
        .returning();

      // Add all workspace members as participants
      const allMembers = await db
        .select({ userId: workspaceMembers.userId })
        .from(workspaceMembers)
        .where(eq(workspaceMembers.workspaceId, workspaceId as string));

      if (allMembers.length > 0) {
        await db.insert(conversationParticipants).values(
          allMembers.map((m) => ({
            conversationId: channel.id,
            userId: m.userId,
            role: "member" as const,
          }))
        );
      }

      return text({
        id: channel.id,
        workspaceId: channel.workspaceId,
        name: channel.name,
        title: channel.title,
        createdAt: channel.createdAt.toISOString(),
        updatedAt: channel.updatedAt.toISOString(),
      });
    }
  );

  // --- get_messages ---
  server.registerTool(
    "get_messages",
    {
      description:
        "Fetch messages from a conversation (paginated). Returns in chronological order.",
      inputSchema: {
        conversationId: z.string().uuid().describe("The conversation ID"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Max messages to return (default 50, max 100)"),
        before: z
          .string()
          .optional()
          .describe("ISO timestamp cursor for pagination — fetch messages before this time"),
      },
    },
    async ({ conversationId, limit, before }, extra) => {
      const user = getUser(extra);

      // Validate participation
      const [participant] = await db
        .select()
        .from(conversationParticipants)
        .where(
          and(
            eq(
              conversationParticipants.conversationId,
              conversationId as string
            ),
            eq(conversationParticipants.userId, user.id)
          )
        )
        .limit(1);

      if (!participant) {
        return error("Not a participant of this conversation");
      }

      const maxLimit = Math.min((limit as number) || 50, 100);
      const conditions = [
        eq(messages.conversationId, conversationId as string),
      ];
      if (before) {
        conditions.push(lt(messages.createdAt, new Date(before as string)));
      }

      const rows = await db
        .select({
          id: messages.id,
          conversationId: messages.conversationId,
          senderId: messages.senderId,
          content: messages.content,
          createdAt: messages.createdAt,
          senderName: users.name,
        })
        .from(messages)
        .innerJoin(users, eq(messages.senderId, users.id))
        .where(and(...conditions))
        .orderBy(desc(messages.createdAt))
        .limit(maxLimit);

      return text(
        rows.reverse().map((r) => ({
          id: r.id,
          conversationId: r.conversationId,
          senderId: r.senderId,
          senderName: r.senderName,
          content: r.content,
          createdAt: r.createdAt.toISOString(),
        }))
      );
    }
  );

  // --- send_message ---
  server.registerTool(
    "send_message",
    {
      description: "Send a message to a conversation.",
      inputSchema: {
        conversationId: z.string().uuid().describe("The conversation ID"),
        content: z.string().min(1).describe("Message content"),
      },
    },
    async ({ conversationId, content }, extra) => {
      const user = getUser(extra);

      // Validate participation
      const [participant] = await db
        .select()
        .from(conversationParticipants)
        .where(
          and(
            eq(
              conversationParticipants.conversationId,
              conversationId as string
            ),
            eq(conversationParticipants.userId, user.id)
          )
        )
        .limit(1);

      if (!participant) {
        return error("Not a participant of this conversation");
      }

      const [msg] = await db
        .insert(messages)
        .values({
          conversationId: conversationId as string,
          senderId: user.id,
          content: (content as string).trim(),
        })
        .returning();

      const createdAt = msg.createdAt.toISOString();

      // Fire-and-forget webhook notifications for @mentioned bots
      processMessageMentions({
        id: msg.id,
        content: msg.content,
        conversationId: msg.conversationId,
        senderId: msg.senderId,
        senderName: user.name,
        createdAt,
      });

      return text({
        id: msg.id,
        conversationId: msg.conversationId,
        senderId: msg.senderId,
        senderName: user.name,
        content: msg.content,
        createdAt,
      });
    }
  );

  // --- create_dm ---
  server.registerTool(
    "create_dm",
    {
      description:
        "Create or get an existing DM conversation with another user in a workspace.",
      inputSchema: {
        workspaceId: z.string().min(1).describe("The workspace ID"),
        otherUserId: z.string().uuid().describe("The other user's ID"),
      },
    },
    async ({ workspaceId, otherUserId }, extra) => {
      const user = getUser(extra);

      if (otherUserId === user.id) {
        return error("Cannot create DM with yourself");
      }

      // Check both users are workspace members
      const memberCheck = await db
        .select({ userId: workspaceMembers.userId })
        .from(workspaceMembers)
        .where(eq(workspaceMembers.workspaceId, workspaceId as string));

      const memberIds = new Set(memberCheck.map((m) => m.userId));
      if (!memberIds.has(user.id) || !memberIds.has(otherUserId as string)) {
        return error("Both users must be workspace members");
      }

      // Check if DM already exists
      const myDmConvos = await db
        .select({
          conversationId: conversationParticipants.conversationId,
        })
        .from(conversationParticipants)
        .where(eq(conversationParticipants.userId, user.id));

      for (const { conversationId } of myDmConvos) {
        const [conv] = await db
          .select()
          .from(conversations)
          .where(
            and(
              eq(conversations.id, conversationId),
              eq(conversations.type, "direct"),
              eq(conversations.workspaceId, workspaceId as string)
            )
          )
          .limit(1);

        if (!conv) continue;

        const [otherParticipant] = await db
          .select()
          .from(conversationParticipants)
          .where(
            and(
              eq(conversationParticipants.conversationId, conversationId),
              eq(conversationParticipants.userId, otherUserId as string)
            )
          )
          .limit(1);

        if (otherParticipant) {
          const [otherUser] = await db
            .select({
              id: users.id,
              name: users.name,
              email: users.email,
              avatar: users.avatar,
            })
            .from(users)
            .where(eq(users.id, otherUserId as string))
            .limit(1);

          return text({
            id: conv.id,
            otherUser: otherUser!,
            lastMessage: null,
          });
        }
      }

      // Create new DM
      const [otherUser] = await db
        .select({
          id: users.id,
          name: users.name,
          email: users.email,
          avatar: users.avatar,
        })
        .from(users)
        .where(eq(users.id, otherUserId as string))
        .limit(1);

      if (!otherUser) {
        return error("User not found");
      }

      const [conv] = await db
        .insert(conversations)
        .values({
          type: "direct",
          workspaceId: workspaceId as string,
        })
        .returning();

      await db.insert(conversationParticipants).values([
        {
          conversationId: conv.id,
          userId: user.id,
          role: "member" as const,
        },
        {
          conversationId: conv.id,
          userId: otherUserId as string,
          role: "member" as const,
        },
      ]);

      return text({
        id: conv.id,
        otherUser,
        lastMessage: null,
      });
    }
  );
}
