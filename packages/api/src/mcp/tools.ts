import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  listUserWorkspaces,
  getWorkspaceDetail,
  createWorkspace,
  joinWorkspace,
} from "../services/workspaces";
import {
  createOrGetDm,
  listUserDms,
  createChannel,
} from "../services/conversations";
import { getMessages, sendMessage } from "../services/messages";
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
      return withService(() =>
        joinWorkspace(workspaceId as string, user.id)
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
}
