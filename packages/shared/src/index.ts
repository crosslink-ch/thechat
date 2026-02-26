// -- Message Parts (rich message model) --

export type MessagePart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; args: Record<string, unknown> }
  | { type: "tool-result"; toolCallId: string; toolName: string; result: unknown; isError?: boolean };

export interface Message {
  id: string;
  conversation_id: string;
  role: "user" | "assistant" | "tool";
  parts: MessagePart[];
  created_at: string;
}

// -- Database message shape (matches backend) --

export interface DbMessage {
  id: string;
  conversation_id: string;
  role: "user" | "assistant";
  content: string;
  reasoning_content: string | null;
  created_at: string;
}

// -- Conversation & Config --

export interface Conversation {
  id: string;
  title: string;
  project_dir: string | null;
  created_at: string;
  updated_at: string;
}

export interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  requiresAuth?: boolean;
}

export interface AppConfig {
  api_key: string;
  model: string;
  provider?: "openrouter" | "codex";
  mcpServers?: Record<string, McpServerConfig>;
}

// -- Todo Items --

export interface TodoItem {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
  priority?: "high" | "medium" | "low";
}

// -- Credential Types --

export type CredentialType = "bearer" | "api_key" | "secret";

export interface CredentialInfo {
  name: string;
  description: string;
  type: CredentialType;
}

export interface CredentialValue {
  credential_name: string;
  type: CredentialType;
  value: string;
}

// -- Auth Types --

export interface AuthUser {
  id: string;
  name: string;
  email: string | null;
  avatar: string | null;
  type: "human" | "bot";
}

export interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  user: AuthUser;
}

export interface RegisterResponse {
  accessToken?: string;
  refreshToken?: string;
  user?: AuthUser;
  message?: string;
}

// -- Workspace Types --

export type WorkspaceMemberRole = "member" | "admin" | "owner";

export interface Workspace {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceMember {
  userId: string;
  role: WorkspaceMemberRole;
  joinedAt: string;
  user: AuthUser;
}

export interface WorkspaceChannel {
  id: string;
  workspaceId: string;
  name: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceWithDetails extends Workspace {
  members: WorkspaceMember[];
  channels: WorkspaceChannel[];
}

export interface WorkspaceListItem extends Workspace {
  role: WorkspaceMemberRole;
}

// -- Chat Parameters --

export interface ChatParams {
  model?: string;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  max_tokens?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  stop?: string[];
  tool_choice?: "auto" | "none" | "required" | { type: "function"; function: { name: string } };
  response_format?: {
    type: "json_schema";
    json_schema: { name: string; strict?: boolean; schema: Record<string, unknown> };
  };
  reasoning_effort?: "low" | "medium" | "high";
  thinking?: { type: "enabled"; budget_tokens: number };
  seed?: number;
  provider?: { allow_fallbacks?: boolean; order?: string[] };
}

// -- Stream Events (core → UI callback) --

export type StreamEvent =
  | { type: "text-delta"; text: string }
  | { type: "reasoning-delta"; text: string }
  | { type: "tool-call-start"; toolCallId: string; toolName: string }
  | { type: "tool-call-args-delta"; toolCallId: string; args: string }
  | { type: "tool-call-complete"; toolCallId: string; toolName: string; args: Record<string, unknown> }
  | { type: "tool-result"; toolCallId: string; toolName: string; result: unknown; isError: boolean }
  | { type: "finish"; usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } }
  | { type: "error"; error: string };

// -- Stream Result (returned from streamCompletion) --

export interface ToolCallResult {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface StreamResult {
  text: string;
  reasoning: string;
  toolCalls: ToolCallResult[];
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

// -- Human-to-Human Chat Types --

export interface ChatMessage {
  id: string;
  conversationId: string;
  senderId: string;
  senderName: string;
  content: string;
  createdAt: string;
}

export interface DirectConversation {
  id: string;
  otherUser: AuthUser;
  lastMessage: ChatMessage | null;
}

// -- WebSocket Event Types --

export type WsClientEvent =
  | { type: "auth"; token: string }
  | { type: "send_message"; conversationId: string; content: string }
  | { type: "typing"; conversationId: string };

// -- Bot Types --

export interface Bot {
  id: string;
  userId: string;
  name: string;
  webhookUrl: string | null;
  createdAt: string;
}

export interface BotWithApiKey extends Bot {
  apiKey: string;
  webhookSecret: string;
}

export interface WebhookPayload {
  event: "mention";
  message: {
    id: string;
    content: string;
    conversationId: string;
    senderId: string;
    senderName: string;
    createdAt: string;
  };
  conversation: {
    id: string;
    type: "direct" | "group";
    name: string | null;
    workspaceId: string | null;
  };
  workspace: { id: string; name: string } | null;
  bot: { id: string; name: string };
}

// -- Workspace Invite Types --

export interface WorkspaceInvite {
  id: string;
  workspaceId: string;
  workspaceName: string;
  inviterId: string;
  inviterName: string;
  inviteeId?: string;
  createdAt: string;
}

export type AppNotification =
  | { type: "workspace_invite"; invite: WorkspaceInvite };

// -- WebSocket Event Types --

export type WsServerEvent =
  | { type: "auth_ok"; userId: string }
  | { type: "auth_error"; message: string }
  | { type: "new_message"; message: ChatMessage; conversationType: "direct" | "group" }
  | { type: "typing"; conversationId: string; userId: string; userName: string }
  | { type: "member_joined"; workspaceId: string; member: WorkspaceMember }
  | { type: "member_role_changed"; workspaceId: string; userId: string; newRole: WorkspaceMemberRole }
  | { type: "member_removed"; workspaceId: string; userId: string }
  | { type: "invite_received"; invite: WorkspaceInvite }
  | { type: "error"; message: string };
