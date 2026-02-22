import type { SkillInfo } from "../types";

export const theChatBackendSkill: SkillInfo = {
  name: "thechat-backend",
  description:
    "Interact with TheChat backend — manage workspaces, invite users, channels, DMs, and messages",
  location: "builtin",
  mcpServers: ["thechat"],
  content: `# TheChat Backend Skill

Use the TheChat MCP tools (prefixed with \`thechat__\`) to interact with the backend on behalf of the user.
The exact tools available are discovered dynamically from the MCP server — inspect the tool list after this skill loads.

## Usage Guidelines

- Always start by calling \`thechat__get_me\` to confirm the user's identity.
- Use the workspace and channel tools to discover what the user has access to.
- When sending messages, the message is sent as the authenticated user.
- Pagination: message fetching supports \`limit\` (max 100) and \`before\` (ISO timestamp) for fetching older messages.
- Channel creation adds all workspace members automatically.
- DM creation is idempotent — calling it twice returns the same conversation.
- To add users to a workspace, use \`thechat__invite_to_workspace\` with their email address. Only workspace owners and admins can invite.
- Users cannot join workspaces directly — they must be invited.

## Important

- The user must be authenticated for these tools to work.
- Only interact with workspaces/conversations the user has access to.
- Do not send messages without the user's explicit instruction or approval.
`,
};
