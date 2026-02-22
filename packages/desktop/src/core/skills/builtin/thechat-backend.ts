import type { SkillInfo } from "../types";

export const theChatBackendSkill: SkillInfo = {
  name: "thechat-backend",
  description:
    "Interact with TheChat backend — manage workspaces, channels, DMs, and messages",
  location: "builtin",
  mcpServers: ["thechat"],
  content: `# TheChat Backend Skill

Use the TheChat MCP tools to interact with the backend on behalf of the user.

## Available Tools

After this skill loads, you will have access to these tools (prefixed with \`thechat__\`):

| Tool | Description |
|------|-------------|
| \`thechat__get_me\` | Get the authenticated user's profile |
| \`thechat__list_workspaces\` | List workspaces the user belongs to |
| \`thechat__get_workspace\` | Get workspace details (members, channels) |
| \`thechat__create_workspace\` | Create a new workspace |
| \`thechat__join_workspace\` | Join an existing workspace |
| \`thechat__list_dms\` | List DM conversations in a workspace |
| \`thechat__create_dm\` | Create or get a DM with another user |
| \`thechat__create_channel\` | Create a channel in a workspace |
| \`thechat__get_messages\` | Fetch messages from a conversation |
| \`thechat__send_message\` | Send a message to a conversation |

## Usage Guidelines

- Always start by calling \`thechat__get_me\` to confirm the user's identity.
- Use \`thechat__list_workspaces\` to discover which workspaces the user belongs to.
- Use \`thechat__get_workspace\` to see channels and members within a workspace.
- When sending messages, the message is sent as the authenticated user.
- Pagination: \`thechat__get_messages\` supports \`limit\` (max 100) and \`before\` (ISO timestamp) for fetching older messages.
- Channel creation adds all workspace members automatically.
- DM creation is idempotent — calling it twice returns the same conversation.

## Important

- The user must be authenticated for these tools to work.
- Only interact with workspaces/conversations the user has access to.
- Do not send messages without the user's explicit instruction or approval.
`,
};
