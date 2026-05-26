import type { SkillInfo } from "../types";

export const createBotSkill: SkillInfo = {
  name: "create-bot",
  description: "Create and configure bots for thechat workspaces",
  location: "builtin",
  mcpServers: ["thechat"],
  content: `# Create Bot Skill

Guide the user through creating and configuring a bot for thechat.
This skill activates the TheChat MCP tools (prefixed with \`thechat__\`) — use them for bot registration and workspace management.

## Overview

Bots in thechat are special users that can be added to workspaces and channels. The two common bot types are:
- **Webhook bots** — custom bots that receive a signed webhook when @mentioned, then post their own response.
- **Hermes bots** — native bots backed by a Hermes Gateway TheChat platform adapter. Hermes Gateway consumes TheChat messages as platform events and posts replies back as the bot.

Webhook bots have:
- A **name** — displayed in channels like any user
- A **webhook URL** — receives POST requests when the bot is @mentioned
- An **API key** — used to authenticate the bot's responses (prefixed with \`bot_\`)

Hermes bots have:
- A **name** — any user-facing bot name, not necessarily "Hermes"
- A **bot token** — the created bot's \`apiKey\`, prefixed with \`bot_\`, used by Hermes Gateway to connect as that bot
- Optional default instructions/session settings
- A running Hermes Gateway configured with TheChat platform adapter credentials for that specific bot

## Steps

Use these steps for ordinary webhook bots. If the user asks for Hermes, use the Hermes-specific flow below instead.

### 1. Create the bot

Use the \`thechat__create_bot\` tool (or the relevant bot creation tool from the MCP server) to register a new bot.
The webhook URL is optional and can be set later. The response includes the bot's \`apiKey\` — remind the user to save it, as it cannot be retrieved again.

### 2. Add the bot to a workspace

Use the \`thechat__add_bot_to_workspace\` tool (or the relevant tool) to add the bot to a workspace.
This makes the bot a member of the workspace and all its channels.

### 3. Build the webhook handler

The webhook receives POST requests with this payload:

\`\`\`json
{
  "event": "mention",
  "message": {
    "id": "...",
    "content": "Hey @my-bot what's up?",
    "conversationId": "...",
    "senderId": "...",
    "senderName": "Alice",
    "createdAt": "..."
  },
  "conversation": { "id": "...", "type": "group", "name": "general", "workspaceId": "..." },
  "workspace": { "id": "...", "name": "My Workspace" },
  "bot": { "id": "...", "name": "my-bot" }
}
\`\`\`

The bot replies by sending a message to the conversation using the \`thechat__send_message\` tool or directly:

\`\`\`
POST /messages/:conversationId
Authorization: Bearer <bot-api-key>
Body: { "content": "Hello! I'm a bot." }
\`\`\`

### 4. Test the bot (how the user can test it)

1. Open a channel where the bot is a member
2. Send a message mentioning \`@bot-name\`
3. The webhook fires and the bot should respond

### Technology for the bot

Unless the user specifies otherwise, prefer using Bun and TypeScript for building the bot.

## Tips

- Use the MCP tools to list workspaces, inspect bot details, or manage bot-workspace memberships — check the available \`thechat__\` tools after this skill loads.
- If you're unsure about something (e.g. what to name the bot, webhook URL), ask the user for clarification

## Hermes bot wiring

Use this flow when the user asks to add, connect, configure, or wire up a Hermes bot.

### 1. Create a Hermes bot user

Create the chat participant as a normal bot with \`kind: "hermes"\`, a workspace ID, and the chosen display name. You can omit \`webhookUrl\`; Hermes Gateway can later register its callback through the generic bot webhook endpoint when started in webhook mode.

\`\`\`json
{
  "kind": "hermes",
  "workspaceId": "<workspace-id>",
  "name": "Koda"
}
\`\`\`

If using HTTP directly:

\`\`\`
POST /bots/create
Authorization: Bearer <human-user-token>
Body: { "kind": "hermes", "workspaceId": "<workspace-id>", "name": "Koda", "webhookUrl": "<optional public Hermes webhook URL>" }
\`\`\`

Only workspace owners/admins can create Hermes bots. The create response includes the bot's \`apiKey\`; treat it as the bot token and show it to the user because it is needed by the Hermes Gateway process.

### 2. Start Hermes Gateway for that bot

Hermes Gateway must run with TheChat enabled as a messaging platform. TheChat does not call the Hermes run API for bot replies; Hermes Gateway consumes TheChat platform events through either polling or webhook delivery.

Assume the user will put the per-bot TheChat settings in the Hermes Gateway \`.env\` file instead of prepending environment variables to the run command. The gateway needs the per-bot token from the create response:

\`\`\`
THECHAT_BASE_URL=<TheChat API URL>
THECHAT_BOT_TOKEN=<bot apiKey from /bots/create>
THECHAT_ALLOW_ALL_USERS=true

# Choose one delivery mode.
# Polling mode:
THECHAT_POLL_INTERVAL=1.0

# Webhook mode:
# THECHAT_WEBHOOK_URL=<public Hermes webhook URL>
\`\`\`

For polling mode, Hermes claims queued invocations from \`/hermes-platform/events\`. For webhook mode, Hermes registers \`THECHAT_WEBHOOK_URL\` through \`POST /bots/me/webhook\` using its bot token, and TheChat pushes queued invocations to that callback.

Each Hermes bot gets its own token. To run multiple Hermes bots, repeat the bot creation flow and run one Hermes Gateway process per bot token, each with its own Hermes home/config.

Do not put Hermes connection settings in generic bot creation. Runtime connectivity belongs to the Hermes Gateway TheChat platform adapter, not the bot record.

### 3. Configure bot defaults

Optionally configure TheChat-side defaults for the created Hermes bot:

\`\`\`
PATCH /bots/:botId/hermes
Authorization: Bearer <human-user-token>
Body: {
  "defaultMode": "run",
  "defaultInstructions": "Reply concisely in TheChat.",
  "defaultSessionScope": "channel"
}
\`\`\`

Hermes Gateway's TheChat platform hint includes TheChat LaTeX math formatting
rules, so default instructions only need bot-specific behavior.

To validate TheChat-side bot configuration:

\`\`\`
POST /bots/:botId/hermes/test
Authorization: Bearer <human-user-token>
Body: {}
\`\`\`

### 4. Explain how users interact with Hermes bots

- In channels/groups, users mention the specific bot name, for example \`@Koda summarize this thread\`.
- In direct messages with a workspace Hermes bot, users can message the bot without an @mention and it should respond.
- TheChat stores generic bot session, invocation, and event metadata for UI/history; Hermes Gateway owns the actual model runtime and session memory.
- With no bot \`webhookUrl\`, Hermes polls \`/hermes-platform/events\`; in webhook mode Hermes registers \`THECHAT_WEBHOOK_URL\` through \`POST /bots/me/webhook\`, TheChat pushes queued invocations to that callback, and Hermes posts bot messages through \`/hermes-platform/messages\` while reporting invocation lifecycle through \`/hermes-platform/invocations/:id/*\`.
`,
};
