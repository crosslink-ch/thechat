import type { SkillInfo } from "../types";

export const createBotSkill: SkillInfo = {
  name: "create-bot",
  description: "Create and configure bots for thechat workspaces",
  location: "builtin",
  content: `# Create Bot Skill

Guide the user through creating and configuring a bot for thechat.

## Overview

Bots in thechat are special users that can be added to workspaces and respond to @mentions via webhooks. Each bot has:
- A **name** — displayed in channels like any user
- A **webhook URL** — receives POST requests when the bot is @mentioned
- An **API key** — used to authenticate the bot's responses (prefixed with \`bot_\`)

## Steps

### 1. Create the bot

The user needs to be authenticated. Call the API to create a bot:

\`\`\`
POST /bots/create
Authorization: Bearer <user-token>
Body: { "name": "my-bot", "webhookUrl": "https://example.com/webhook" }
\`\`\`

The webhook URL is optional and can be set later. The response includes the bot's \`apiKey\` — remind the user to save it, as it cannot be retrieved again.

### 2. Add the bot to a workspace

\`\`\`
POST /bots/:botId/workspaces
Authorization: Bearer <user-token>
Body: { "workspaceId": "workspace-id" }
\`\`\`

This adds the bot as a member of the workspace and all its channels.

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

The bot replies by sending a message to the conversation:

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

- The webhook URL must be publicly accessible. Use ngrok for local development.
- Bot API keys can be regenerated via \`POST /bots/:botId/regenerate-key\`
- To remove a bot from a workspace: \`DELETE /bots/:botId/workspaces/:workspaceId\`
- If you're unsure about something (e.g. what to name the bot, webhook URL), ask the user for clarification
`,
};
