import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  listUserWorkspaces,
  getWorkspaceDetail,
  createWorkspace,
  updateMemberRole,
  removeMember,
} from "../services/workspaces";
import { createInvite } from "../services/invites";
import {
  createOrGetDm,
  listUserDms,
  createChannel,
} from "../services/conversations";
import { getMessages, sendMessage } from "../services/messages";
import {
  createBot,
  listBots,
  getBot,
  updateBot,
  deleteBot,
  addBotToWorkspace,
  removeBotFromWorkspace,
  regenerateBotKey,
  regenerateBotSecret,
} from "../services/bots";
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

async function withService<T>(fn: () => Promise<T>) {
  try {
    return text(await fn());
  } catch (e: any) {
    return error(e.message ?? "Unknown error");
  }
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
      return withService(() => listUserWorkspaces(user.id));
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
      return withService(() =>
        getWorkspaceDetail(workspaceId as string, user.id)
      );
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
      return withService(() => createWorkspace(name as string, user.id));
    }
  );

  // --- invite_to_workspace ---
  server.registerTool(
    "invite_to_workspace",
    {
      description:
        "Invite a user to a workspace by their email address. Only workspace owners and admins can invite. The invited user will receive a notification and can accept or decline.",
      inputSchema: {
        workspaceId: z.string().min(1).describe("The workspace ID"),
        email: z.string().email().describe("Email address of the user to invite"),
      },
    },
    async ({ workspaceId, email }, extra) => {
      const user = getUser(extra);
      return withService(() =>
        createInvite(workspaceId as string, user.id, email as string)
      );
    }
  );

  // --- update_member_role ---
  server.registerTool(
    "update_member_role",
    {
      description:
        "Change a workspace member's role. Owners can promote members to admin or demote admins to member. Admins can only manage regular members.",
      inputSchema: {
        workspaceId: z.string().min(1).describe("The workspace ID"),
        userId: z.string().uuid().describe("The target user's ID"),
        role: z
          .enum(["member", "admin"])
          .describe("The new role: 'member' or 'admin'"),
      },
    },
    async ({ workspaceId, userId, role }, extra) => {
      const user = getUser(extra);
      return withService(() =>
        updateMemberRole(
          workspaceId as string,
          user.id,
          userId as string,
          role as string
        )
      );
    }
  );

  // --- remove_member ---
  server.registerTool(
    "remove_member",
    {
      description:
        "Remove a user from a workspace. Owners can remove any non-owner. Admins can only remove regular members.",
      inputSchema: {
        workspaceId: z.string().min(1).describe("The workspace ID"),
        userId: z.string().uuid().describe("The user ID to remove"),
      },
    },
    async ({ workspaceId, userId }, extra) => {
      const user = getUser(extra);
      return withService(() =>
        removeMember(workspaceId as string, user.id, userId as string)
      );
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
      return withService(() =>
        listUserDms(workspaceId as string, user.id)
      );
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
      return withService(() =>
        createChannel(workspaceId as string, name as string, user.id)
      );
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
          .describe(
            "ISO timestamp cursor for pagination — fetch messages before this time"
          ),
      },
    },
    async ({ conversationId, limit, before }, extra) => {
      const user = getUser(extra);
      return withService(() =>
        getMessages(conversationId as string, user.id, {
          limit: limit as number | undefined,
          before: before as string | undefined,
        })
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
      return withService(() =>
        sendMessage(
          conversationId as string,
          user.id,
          user.name,
          (content as string).trim()
        )
      );
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
      return withService(() =>
        createOrGetDm(
          workspaceId as string,
          user.id,
          otherUserId as string
        )
      );
    }
  );

  // --- create_bot ---
  server.registerTool(
    "create_bot",
    {
      description:
        "Create a new bot. Only human users can create bots. Returns the bot's API key and webhook secret.",
      inputSchema: {
        name: z.string().min(1).describe("Bot name"),
        webhookUrl: z
          .string()
          .url()
          .optional()
          .describe("Optional webhook URL for @mention notifications"),
      },
    },
    async ({ name, webhookUrl }, extra) => {
      const user = getUser(extra);
      if (user.type === "bot") {
        return error("Bots cannot create other bots");
      }
      return withService(() =>
        createBot(
          name as string,
          (webhookUrl as string | undefined) ?? null,
          user.id
        )
      );
    }
  );

  // --- list_bots ---
  server.registerTool(
    "list_bots",
    {
      description: "List bots owned by the authenticated user.",
      inputSchema: {},
    },
    async (_args, extra) => {
      const user = getUser(extra);
      return withService(() => listBots(user.id));
    }
  );

  // --- get_bot ---
  server.registerTool(
    "get_bot",
    {
      description:
        "Get a bot's details including webhook URL and secret. Only the bot owner can view these.",
      inputSchema: {
        botId: z.string().uuid().describe("The bot ID"),
      },
    },
    async ({ botId }, extra) => {
      const user = getUser(extra);
      return withService(() => getBot(botId as string, user.id));
    }
  );

  // --- update_bot ---
  server.registerTool(
    "update_bot",
    {
      description:
        "Update a bot's name and/or webhook URL. Only the bot owner can do this.",
      inputSchema: {
        botId: z.string().uuid().describe("The bot ID"),
        name: z.string().min(1).optional().describe("New bot name"),
        webhookUrl: z
          .string()
          .url()
          .nullish()
          .describe(
            "New webhook URL for @mention notifications. Pass null to remove."
          ),
      },
    },
    async ({ botId, name, webhookUrl }, extra) => {
      const user = getUser(extra);
      const updates: { name?: string; webhookUrl?: string | null } = {};
      if (name !== undefined) updates.name = name as string;
      if (webhookUrl !== undefined)
        updates.webhookUrl = (webhookUrl as string | null | undefined) ?? null;
      return withService(() =>
        updateBot(botId as string, user.id, updates)
      );
    }
  );

  // --- delete_bot ---
  server.registerTool(
    "delete_bot",
    {
      description:
        "Permanently delete a bot. Only the bot owner can do this. The bot's API key will stop working immediately.",
      inputSchema: {
        botId: z.string().uuid().describe("The bot ID"),
      },
    },
    async ({ botId }, extra) => {
      const user = getUser(extra);
      return withService(() => deleteBot(botId as string, user.id));
    }
  );

  // --- add_bot_to_workspace ---
  server.registerTool(
    "add_bot_to_workspace",
    {
      description:
        "Add a bot to a workspace. The caller must be a workspace member. The bot is added to all channels.",
      inputSchema: {
        botId: z.string().uuid().describe("The bot ID"),
        workspaceId: z.string().min(1).describe("The workspace ID"),
      },
    },
    async ({ botId, workspaceId }, extra) => {
      const user = getUser(extra);
      return withService(() =>
        addBotToWorkspace(
          botId as string,
          workspaceId as string,
          user.id
        )
      );
    }
  );

  // --- remove_bot_from_workspace ---
  server.registerTool(
    "remove_bot_from_workspace",
    {
      description:
        "Remove a bot from a workspace. The caller must be a workspace member. The bot is removed from all channels.",
      inputSchema: {
        botId: z.string().uuid().describe("The bot ID"),
        workspaceId: z.string().min(1).describe("The workspace ID"),
      },
    },
    async ({ botId, workspaceId }, extra) => {
      const user = getUser(extra);
      return withService(() =>
        removeBotFromWorkspace(
          botId as string,
          workspaceId as string,
          user.id
        )
      );
    }
  );

  // --- regenerate_bot_key ---
  server.registerTool(
    "regenerate_bot_key",
    {
      description:
        "Regenerate a bot's API key. Only the bot owner can do this. The old key is immediately invalidated.",
      inputSchema: {
        botId: z.string().uuid().describe("The bot ID"),
      },
    },
    async ({ botId }, extra) => {
      const user = getUser(extra);
      return withService(() =>
        regenerateBotKey(botId as string, user.id)
      );
    }
  );

  // --- regenerate_bot_secret ---
  server.registerTool(
    "regenerate_bot_secret",
    {
      description:
        "Regenerate a bot's webhook secret. Only the bot owner can do this.",
      inputSchema: {
        botId: z.string().uuid().describe("The bot ID"),
      },
    },
    async ({ botId }, extra) => {
      const user = getUser(extra);
      return withService(() =>
        regenerateBotSecret(botId as string, user.id)
      );
    }
  );
}
