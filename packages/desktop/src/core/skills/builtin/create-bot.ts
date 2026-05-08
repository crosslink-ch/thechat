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
- **Hermes bots** — native bots wired to an existing Hermes Gateway/API runtime. TheChat starts Hermes runs server-side and posts the final Hermes output as the bot.

Webhook bots have:
- A **name** — displayed in channels like any user
- A **webhook URL** — receives POST requests when the bot is @mentioned
- An **API key** — used to authenticate the bot's responses (prefixed with \`bot_\`)

Hermes bots have:
- A **name** — any user-facing bot name, not necessarily "Hermes"
- A **Hermes base URL** — for example \`http://localhost:18642\`
- A **Hermes API key** — the Hermes Gateway \`API_SERVER_KEY\`; TheChat stores it encrypted and never returns it
- Optional default instructions/session settings for Hermes runs

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

### 1. Confirm the Hermes runtime

The user needs a running Hermes Gateway/API endpoint and an API key. Common local defaults are:

\`\`\`
Hermes base URL: http://localhost:18642
Hermes API key:  <API_SERVER_KEY>
\`\`\`

Do not assume how Hermes Gateway is deployed. Ask the user for the base URL and API key if they have not provided them.

### 2. Create a Hermes bot user

Create the chat participant as a normal bot with \`kind: "hermes"\`, a workspace ID, and the chosen display name.

\`\`\`json
{
  "kind": "hermes",
  "workspaceId": "<workspace-id>",
  "name": "Koda"
}
\`\`\`

Do not put Hermes connection settings in generic bot creation. The Hermes base URL and API key must be sent in the separate Hermes config step.

If using HTTP directly:

\`\`\`
POST /bots/create
Authorization: Bearer <human-user-token>
Body: { "kind": "hermes", "workspaceId": "<workspace-id>", "name": "Koda" }
\`\`\`

Only workspace owners/admins can connect Hermes bots. Multiple Hermes bots can be added to the same workspace by repeating this flow with different names/configs.

### 3. Connect the bot to Hermes Gateway

Configure the created bot with the Hermes runtime details:

\`\`\`
PATCH /bots/:botId/hermes
Authorization: Bearer <human-user-token>
Body: {
  "baseUrl": "http://localhost:18642",
  "apiKey": "<API_SERVER_KEY>",
  "defaultMode": "run",
  "defaultInstructions": "Reply concisely in TheChat.",
  "defaultSessionScope": "channel"
}
\`\`\`

The response must not expose the Hermes API key. To validate the connection:

\`\`\`
POST /bots/:botId/hermes/test
Authorization: Bearer <human-user-token>
Body: {}
\`\`\`

### 4. Explain how users interact with Hermes bots

- In channels/groups, users mention the specific bot name, for example \`@Koda summarize this thread\`.
- In direct messages with a workspace Hermes bot, users can message the bot without an @mention and it should respond.
- TheChat does not store Hermes run/session state as local canonical state; Hermes Gateway owns that runtime state.
- TheChat posts only the final Hermes output back into the conversation as the bot.
`,
};
