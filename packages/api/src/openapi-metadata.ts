export const API_TAGS = {
  system: "System",
  authentication: "Authentication",
  workspaces: "Workspaces",
  conversations: "Conversations",
  messages: "Messages",
  attachments: "Attachments",
  bots: "Bots",
  hermes: "Hermes",
  hermesPlatform: "Hermes Platform",
  botRuntime: "Bot Runtime",
  invitations: "Invitations",
  mcp: "MCP",
} as const;

export const BEARER_AUTH_SECURITY: Array<Record<string, string[]>> = [
  { bearerAuth: [] },
];

export const PUBLIC_SECURITY: Array<Record<string, string[]>> = [];

export const API_TAG_DEFINITIONS = [
  {
    name: API_TAGS.system,
    description: "Service discovery and health checks.",
  },
  {
    name: API_TAGS.authentication,
    description:
      "Human authentication, profile, and personal access token lifecycle.",
  },
  {
    name: API_TAGS.workspaces,
    description: "Workspace membership, configuration, and bot access.",
  },
  {
    name: API_TAGS.conversations,
    description:
      "Direct messages, channels, threads, and conversation metadata.",
  },
  {
    name: API_TAGS.messages,
    description: "Message history and message creation.",
  },
  {
    name: API_TAGS.attachments,
    description:
      "Secure attachment upload, download, and lifecycle operations.",
  },
  {
    name: API_TAGS.bots,
    description:
      "Bot identities, credentials, commands, webhooks, and workspace access.",
  },
  {
    name: API_TAGS.hermes,
    description: "Hermes bot provisioning, testing, and capability management.",
  },
  {
    name: API_TAGS.hermesPlatform,
    description: "TheChat platform callbacks used by managed Hermes runtimes.",
  },
  {
    name: API_TAGS.botRuntime,
    description: "Bot runtime context and interactive invocation responses.",
  },
  {
    name: API_TAGS.invitations,
    description: "Human and bot workspace invitation workflows.",
  },
  {
    name: API_TAGS.mcp,
    description: "Stateless Streamable HTTP access to TheChat's MCP server.",
  },
];
