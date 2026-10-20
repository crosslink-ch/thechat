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
  createHermesBotInWorkspace,
  listBots,
  getBot,
  updateBot,
  deleteBot,
  regenerateBotKey,
  regenerateBotSecret,
} from "../services/bots";
import {
  getHermesBotCapabilities,
  getHermesBotConfig,
  testHermesBot,
  updateHermesBotConfig,
} from "../services/hermes";
import {
  addOwnedBotToWorkspace,
  removeBotWorkspaceMembership,
} from "../services/bot-workspace-memberships";
import {
  createBotRequest,
  MAX_BOT_REQUEST_WAIT_SECONDS,
  newBotRequestIdempotencyKey,
  waitForBotRequest,
} from "../services/bot-requests";
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
      description:
        "Send a message to a conversation with optional ready attachment IDs.",
      inputSchema: {
        conversationId: z.string().uuid().describe("The conversation ID"),
        clientMessageId: z
          .string()
          .min(1)
          .max(255)
          .optional()
          .describe("Stable sender-scoped idempotency key"),
        content: z.string().optional().describe("Message content"),
        attachmentIds: z
          .array(z.string().uuid())
          .max(25)
          .optional()
          .describe("Ready attachment IDs in display order"),
      },
    },
    async (
      { conversationId, clientMessageId, content, attachmentIds },
      extra,
    ) => {
      const user = getUser(extra);
      return withService(() =>
        sendMessage(
          conversationId as string,
          user.id,
          user.name,
          ((content as string | undefined) ?? "").trim(),
          {
            clientMessageId: clientMessageId as string | undefined,
            attachmentIds: attachmentIds as string[] | undefined,
          },
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

  // --- create_hermes_bot ---
  server.registerTool(
    "create_hermes_bot",
    {
      description:
        "Create a Hermes bot and add it to a workspace. The caller must be a human workspace owner or admin. Returns the bot token once.",
      inputSchema: {
        name: z.string().trim().min(1).describe("Hermes bot name"),
        workspaceId: z.string().trim().min(1).describe("Workspace ID"),
        webhookUrl: z
          .string()
          .url()
          .optional()
          .describe("Optional webhook URL"),
        attachmentAccess: z
          .boolean()
          .optional()
          .describe(
            "Allow the bot to receive and upload attachments (default true)",
          ),
      },
    },
    async ({ name, workspaceId, webhookUrl, attachmentAccess }, extra) => {
      const user = getUser(extra);
      if (user.type === "bot") {
        return error("Bots cannot create other bots");
      }
      return withService(async () => {
        const bot = await createHermesBotInWorkspace(
          name as string,
          (webhookUrl as string | undefined) ?? null,
          user.id,
          workspaceId as string,
          (attachmentAccess as boolean | undefined) ?? true,
        );
        const { webhookSecret: _webhookSecret, ...publicBot } = bot;
        return publicBot;
      });
    },
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
        "Add a bot you own to a workspace you administer. The bot is added to all channels and any matching pending approval request is resolved.",
      inputSchema: {
        botId: z.string().uuid().describe("The bot ID"),
        workspaceId: z.string().min(1).describe("The workspace ID"),
      },
    },
    async ({ botId, workspaceId }, extra) => {
      const user = getUser(extra);
      return withService(() =>
        addOwnedBotToWorkspace(
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
        "Remove a bot from a workspace as the bot owner or a workspace administrator. The bot is removed from all channels and connected workspace clients are updated.",
      inputSchema: {
        botId: z.string().uuid().describe("The bot ID"),
        workspaceId: z.string().min(1).describe("The workspace ID"),
      },
    },
    async ({ botId, workspaceId }, extra) => {
      const user = getUser(extra);
      return withService(() =>
        removeBotWorkspaceMembership(
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

  // --- Hermes bot management ---
  server.registerTool(
    "get_hermes_bot_config",
    {
      description:
        "Get the supported public configuration for a Hermes bot. Only the bot owner can view it.",
      inputSchema: {
        botId: z.string().uuid().describe("The Hermes bot ID"),
      },
    },
    async ({ botId }, extra) => {
      const user = getUser(extra);
      return withService(() => getHermesBotConfig(botId as string, user.id));
    },
  );

  server.registerTool(
    "update_hermes_bot_config",
    {
      description:
        "Update a Hermes bot's supported configuration. Only the bot owner can update it.",
      inputSchema: {
        botId: z.string().uuid().describe("The Hermes bot ID"),
        defaultMode: z
          .enum(["run", "response"])
          .describe("Default Hermes invocation mode"),
      },
    },
    async ({ botId, defaultMode }, extra) => {
      const user = getUser(extra);
      return withService(() =>
        updateHermesBotConfig(botId as string, user.id, {
          defaultMode: defaultMode as "run" | "response",
        }),
      );
    },
  );

  server.registerTool(
    "test_hermes_bot",
    {
      description:
        "Check the TheChat-side setup for a Hermes bot. Only the bot owner can test it.",
      inputSchema: {
        botId: z.string().uuid().describe("The Hermes bot ID"),
      },
    },
    async ({ botId }, extra) => {
      const user = getUser(extra);
      return withService(() => testHermesBot(botId as string, user.id));
    },
  );

  server.registerTool(
    "get_hermes_bot_capabilities",
    {
      description:
        "Get TheChat capabilities supported by a Hermes bot. Only the bot owner can view them.",
      inputSchema: {
        botId: z.string().uuid().describe("The Hermes bot ID"),
      },
    },
    async ({ botId }, extra) => {
      const user = getUser(extra);
      return withService(() =>
        getHermesBotCapabilities(botId as string, user.id),
      );
    },
  );

  // --- Bot requests: ask a human through TheChat's inbox ---
  // Bot tokens only. The request shows in the conversation and the Inbox;
  // any participant may answer unless `audienceUserId` names one person.
  const requestPlacement = {
    conversationId: z
      .string()
      .uuid()
      .optional()
      .describe(
        "Conversation to ask in. Defaults to the bot's DM with its owner.",
      ),
    threadId: z.string().uuid().optional().describe("Thread in that conversation"),
    audienceUserId: z
      .string()
      .uuid()
      .optional()
      .describe("Only this person may answer. Omit to let any participant answer."),
    clientKey: z
      .string()
      .min(1)
      .max(255)
      .optional()
      .describe(
        "Idempotency key. Retrying with the same key returns the same request.",
      ),
    expiresInSeconds: z
      .number()
      .int()
      .positive()
      .max(30 * 24 * 60 * 60)
      .optional()
      .describe("Close the request automatically after this many seconds"),
    waitSeconds: z
      .number()
      .int()
      .min(0)
      .max(MAX_BOT_REQUEST_WAIT_SECONDS)
      .optional()
      .describe(
        `Wait up to this long for an answer before returning (default 45, max ${MAX_BOT_REQUEST_WAIT_SECONDS}). Call get_request to keep waiting.`,
      ),
  };

  const createAndWait = async (
    user: McpUser,
    input: {
      kind: "approval" | "question";
      title: string;
      body?: string;
      details?: Record<string, unknown>;
      response?: Parameters<typeof createBotRequest>[1]["response"];
      conversationId?: string;
      threadId?: string;
      audienceUserId?: string;
      clientKey?: string;
      expiresInSeconds?: number;
      waitSeconds?: number;
    },
    signal?: AbortSignal,
  ) => {
    const actor = { id: user.id, type: user.type };
    const { request } = await createBotRequest(actor, {
      clientKey: input.clientKey ?? newBotRequestIdempotencyKey(),
      kind: input.kind,
      title: input.title,
      body: input.body ?? null,
      details: input.details ?? null,
      response: input.response ?? null,
      conversationId: input.conversationId ?? null,
      threadId: input.threadId ?? null,
      audienceUserId: input.audienceUserId ?? null,
      expiresAt: input.expiresInSeconds
        ? new Date(Date.now() + input.expiresInSeconds * 1000)
        : null,
    });
    const waitSeconds = input.waitSeconds ?? 45;
    if (waitSeconds === 0 || request.status !== "open") return request;
    return waitForBotRequest(actor, request.id, waitSeconds, signal);
  };

  server.registerTool(
    "request_approval",
    {
      description:
        "Ask a person in TheChat to approve an action, then wait for the decision. " +
        "Returns the request; status is open until someone answers. Bot tokens only.",
      inputSchema: {
        title: z.string().min(1).max(500).describe("What needs approval"),
        body: z.string().max(20_000).optional().describe("Markdown context"),
        command: z.string().max(100_000).optional().describe("Command to show verbatim"),
        cwd: z.string().max(1_000).optional().describe("Working directory of the command"),
        links: z
          .array(z.object({ url: z.string().url(), label: z.string().max(200).optional() }))
          .max(10)
          .optional()
          .describe("Links to show, e.g. a diff or CI run"),
        choices: z
          .array(z.string().min(1).max(200))
          .min(1)
          .max(20)
          .optional()
          .describe("Allowed decisions. Defaults to approve and deny."),
        labels: z
          .record(z.string(), z.string().min(1).max(200))
          .optional()
          .describe("Button labels keyed by choice"),
        allowComment: z.boolean().optional().describe("Let the person add a comment"),
        ...requestPlacement,
      },
    },
    async (args, extra) => {
      const user = getUser(extra);
      const details: Record<string, unknown> = {};
      if (args.command) details.command = args.command;
      if (args.cwd) details.cwd = args.cwd;
      if (args.links?.length) details.links = args.links;
      return withService(() =>
        createAndWait(
          user,
          {
            kind: "approval",
            title: args.title,
            body: args.body,
            details: Object.keys(details).length > 0 ? details : undefined,
            response: args.choices
              ? {
                  type: "choice",
                  choices: args.choices,
                  ...(args.labels ? { labels: args.labels } : {}),
                  ...(args.allowComment ? { allowComment: true } : {}),
                }
              : args.allowComment
                ? {
                    type: "choice",
                    choices: ["approve", "deny"],
                    labels: { approve: "Approve", deny: "Deny" },
                    allowComment: true,
                  }
                : undefined,
            conversationId: args.conversationId,
            threadId: args.threadId,
            audienceUserId: args.audienceUserId,
            clientKey: args.clientKey,
            expiresInSeconds: args.expiresInSeconds,
            waitSeconds: args.waitSeconds,
          },
          extra.signal,
        ),
      );
    },
  );

  server.registerTool(
    "ask_question",
    {
      description:
        "Ask a person in TheChat a question, with optional fixed choices, then wait for the answer. " +
        "Returns the request; status is open until someone answers. Bot tokens only.",
      inputSchema: {
        question: z.string().min(1).max(500).describe("The question"),
        body: z.string().max(20_000).optional().describe("Markdown context"),
        choices: z
          .array(z.string().min(1).max(200))
          .min(1)
          .max(20)
          .optional()
          .describe("Fixed answers. Omit for a free-text answer."),
        multiple: z.boolean().optional().describe("Allow picking several choices"),
        allowText: z
          .boolean()
          .optional()
          .describe("With choices: also allow a typed answer"),
        ...requestPlacement,
      },
    },
    async (args, extra) => {
      const user = getUser(extra);
      return withService(() =>
        createAndWait(
          user,
          {
            kind: "question",
            title: args.question,
            body: args.body,
            response: args.choices
              ? {
                  type: "choice",
                  choices: args.choices,
                  ...(args.multiple ? { multiple: true } : {}),
                  ...(args.allowText ? { allowText: true } : {}),
                }
              : { type: "text" },
            conversationId: args.conversationId,
            threadId: args.threadId,
            audienceUserId: args.audienceUserId,
            clientKey: args.clientKey,
            expiresInSeconds: args.expiresInSeconds,
            waitSeconds: args.waitSeconds,
          },
          extra.signal,
        ),
      );
    },
  );

  server.registerTool(
    "get_request",
    {
      description:
        "Get a bot request by ID, optionally waiting for its status to change. " +
        "A bot sees its own requests; a person sees requests in conversations they belong to.",
      inputSchema: {
        requestId: z.string().uuid().describe("The request ID"),
        waitSeconds: z
          .number()
          .int()
          .min(0)
          .max(MAX_BOT_REQUEST_WAIT_SECONDS)
          .optional()
          .describe(
            `While the request is open, wait up to this long for an answer (default 0, max ${MAX_BOT_REQUEST_WAIT_SECONDS})`,
          ),
      },
    },
    async ({ requestId, waitSeconds }, extra) => {
      const user = getUser(extra);
      return withService(() =>
        waitForBotRequest(
          { id: user.id, type: user.type },
          requestId as string,
          (waitSeconds as number | undefined) ?? 0,
          extra.signal,
        ),
      );
    },
  );
}
