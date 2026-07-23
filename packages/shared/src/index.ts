// -- Message Parts (rich message model) --

export type MessagePart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "image"; path: string; mimeType: string }
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
  lazy?: boolean;
  disabled?: boolean;
}

export type Provider = "openrouter" | "codex" | "glm" | "featherless";
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh";
export type GlmPlanType = "coding" | "standard";

export interface ProviderConfig {
  model: string;
}

export interface ProvidersConfig {
  openrouter: ProviderConfig;
  codex: ProviderConfig;
  glm: ProviderConfig;
  featherless: ProviderConfig;
}

export interface LocalOverrides {
  provider?: boolean;
  apiKey?: boolean;
  openrouterModel?: boolean;
  codexModel?: boolean;
  glmApiKey?: boolean;
  glmModel?: boolean;
  featherlessApiKey?: boolean;
  featherlessModel?: boolean;
  reasoningEffort?: boolean;
}

export interface AppConfig {
  api_key: string;
  glm_api_key?: string;
  glmPlanType?: GlmPlanType;
  featherless_api_key?: string;
  provider?: Provider;
  reasoningEffort?: ReasoningEffort;
  providers: ProvidersConfig;
  mcpServers?: Record<string, McpServerConfig>;
  inheritWorkspaceId?: string;
  localOverrides?: LocalOverrides;
}

// -- Todo Items --

export interface TodoItem {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
  priority?: "high" | "medium" | "low";
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
  bot?: { id: string; kind: BotKind } | null;
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
  reasoning_effort?: "low" | "medium" | "high" | "xhigh";
  verbosity?: "low" | "medium" | "high";
  service_tier?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
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
  | { type: "queued-message-consumed"; id: string; content: string }
  | { type: "compaction"; summary: string }
  | { type: "ui-retry"; errors: Array<{ code: string; error: string }>; attempt: number }
  | { type: "finish"; usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } }
  | { type: "error"; error: string; provider?: Provider; statusCode?: number };

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
  /** Normalized finish reason: "stop", "tool_calls", "length", "content_filter", or "unknown". */
  stopReason: string;
}

// -- Human-to-Human Chat Types --

export interface ChatMessage {
  id: string;
  conversationId: string;
  threadId: string | null;
  senderId: string;
  senderName: string;
  senderType?: "human" | "bot";
  content: string;
  parts?: MessagePart[] | null;
  attachments?: ChatAttachment[];
  createdAt: string;
}

export type AttachmentStatus =
  | "pending_upload"
  | "processing"
  | "ready"
  | "attached"
  | "rejected"
  | "deleting"
  | "deleted";

/**
 * Provider-neutral metadata for a shared attachment. Object-store coordinates
 * and signed URLs are intentionally never part of persisted message DTOs.
 */
export interface ChatAttachment {
  id: string;
  fileName: string;
  /** Alias retained for clients that use generic file descriptors. */
  name: string;
  mediaType: string;
  /** Alias retained for Hermes and MCP adapters. */
  mimeType: string;
  sizeBytes: number;
  kind: "image" | "file";
  width?: number | null;
  height?: number | null;
  status?: AttachmentStatus;
  contentPath: string;
}

export type AttachmentView = ChatAttachment;

export interface DirectConversation {
  id: string;
  otherUser: AuthUser;
  otherBot?: { id: string; kind: BotKind } | null;
  lastMessage: ChatMessage | null;
}

export interface ConversationParticipantPublic {
  userId: string;
  role: WorkspaceMemberRole;
  joinedAt: string;
  user: AuthUser;
  bot?: { id: string; kind: BotKind; commands?: BotCommandPublic[] | null } | null;
}

export interface ConversationDetail {
  id: string;
  type: "direct" | "group";
  workspaceId: string | null;
  name: string | null;
  title: string | null;
  participants: ConversationParticipantPublic[];
}

export interface ConversationThreadPublic {
  id: string;
  conversationId: string;
  botId: string;
  title: string;
  status: string;
  branchPending?: boolean;
  branchFromThreadId?: string | null;
  createdById: string;
  lastActivityAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationThreadsPage {
  items: ConversationThreadPublic[];
  nextCursor: string | null;
  hasMore: boolean;
}

// -- WebSocket Event Types --

export type WsClientEvent =
  | { type: "auth"; token: string }
  | {
      type: "send_message";
      conversationId: string;
      content: string;
      threadId?: string | null;
      clientMessageId?: string;
      attachmentIds?: string[];
    }
  | { type: "typing"; conversationId: string; threadId?: string | null }
  | { type: "ping" };

// -- Bot Types --

export type BotKind = "webhook" | "hermes";

/**
 * A slash command registered by a bot (Telegram setMyCommands-style).
 * Bots replace their full command list via `POST /bots/me/commands`;
 * clients use it to render command menus.
 */
export interface BotCommandPublic {
  /** Canonical command name without the leading slash, e.g. "new". */
  command: string;
  description: string;
  /** Argument placeholder, e.g. "<prompt>" (required) or "[name]" (optional). */
  argsHint?: string | null;
  /** Grouping label, e.g. "Session" or "Configuration". */
  category?: string | null;
  /** Alternative names without the leading slash, e.g. ["reset"]. */
  aliases?: string[];
}

export interface Bot {
  id: string;
  userId: string;
  name: string;
  kind: BotKind;
  attachmentAccess?: boolean;
  webhookUrl: string | null;
  createdAt: string;
}

export interface BotWithApiKey extends Bot {
  apiKey: string;
  webhookSecret: string;
}

export type HermesDefaultMode = "run" | "response";

export const THECHAT_LATEX_FORMATTING_INSTRUCTIONS = `# LaTeX math formatting
- TheChat renders LaTeX math in markdown.
- For **inline math**, use double-dollar delimiters with no spaces inside, like \`$$E = mc^2$$\`.
- For **block math**, use either a standalone double-dollar block:
  \`\`\`
  $$
  \\int_0^1 x^2 \\, dx = \\frac{1}{3}
  $$
  \`\`\`
  or a fenced math block:
  \`\`\`math
  \\int_0^1 x^2 \\, dx = \\frac{1}{3}
  \`\`\`
- Do **not** use single-dollar inline math such as \`$x$\`; single dollars are treated as normal text to avoid conflicts with currency and shell variables.
- Escape literal dollar signs as \`\\$\` when needed.
- Keep LaTeX out of code fences unless you intentionally want a math block.`;

export const DEFAULT_HERMES_THECHAT_INSTRUCTIONS = "Reply concisely in TheChat.";

export interface HermesBotConfigPublic {
  botId: string;
  defaultMode: HermesDefaultMode;
  defaultInstructions: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WebhookPayload {
  event: "mention";
  message: {
    id: string;
    content: string;
    conversationId: string;
    threadId: string | null;
    senderId: string;
    senderName: string;
    attachments: ChatAttachment[];
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

export type BotInvocationStatus =
  | "queued"
  | "running"
  | "claimed"
  | "completed"
  | "failed"
  | "cancelled";

export interface BotInvocationPublic {
  id: string;
  botId: string;
  botUserId: string;
  botName: string;
  botKind: BotKind;
  conversationId: string;
  threadId: string | null;
  triggerMessageId: string;
  responseMessageId: string | null;
  adapterKind: BotKind | string;
  status: BotInvocationStatus | string;
  externalRunId: string | null;
  requestJson: Record<string, unknown> | null;
  responseJson: Record<string, unknown> | null;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BotInvocationProgressEventPublic {
  id: string;
  invocationId: string;
  botId: string;
  conversationId: string;
  threadId: string | null;
  sequence: number;
  type: string;
  status: string | null;
  toolCallId: string | null;
  toolName: string | null;
  label: string | null;
  preview: string | null;
  payload: Record<string, unknown> | null;
  occurredAt: string;
  createdAt: string;
}

export interface BotRuntimeSnapshot {
  invocations: BotInvocationPublic[];
  events: BotInvocationProgressEventPublic[];
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

// -- Workspace Config Types --

export type WorkspaceProvider = "openrouter" | "codex" | "glm" | "featherless";

export interface WorkspaceConfig {
  workspaceId: string;
  provider: WorkspaceProvider | null;
  openrouter: { apiKey: string } | null;
  openrouterModel: string | null;
  codexModel: string | null;
  glm: { apiKey: string } | null;
  glmModel: string | null;
  featherless: { apiKey: string } | null;
  featherlessModel: string | null;
  reasoningEffort: ReasoningEffort | null;
  updatedAt: string;
}

// -- WebSocket Event Types --

export type WsServerEvent =
  | { type: "auth_ok"; userId: string }
  | { type: "auth_error"; message: string }
  | {
      type: "new_message";
      message: ChatMessage;
      conversationType: "direct" | "group";
      clientMessageId?: string;
    }
  | {
      type: "message_error";
      conversationId: string;
      clientMessageId: string;
      message: string;
    }
  | {
      type: "bot_invocation_updated";
      conversationId: string;
      invocation: BotInvocationPublic;
    }
  | {
      type: "bot_invocation_progress";
      conversationId: string;
      invocationId: string;
      event: BotInvocationProgressEventPublic;
      invocation?: BotInvocationPublic;
    }
  | {
      type: "conversation_thread_updated";
      conversationId: string;
      thread: ConversationThreadPublic;
    }
  | {
      type: "typing";
      conversationId: string;
      threadId: string | null;
      userId: string;
      userName: string;
    }
  | { type: "member_joined"; workspaceId: string; member: WorkspaceMember }
  | { type: "member_role_changed"; workspaceId: string; userId: string; newRole: WorkspaceMemberRole }
  | { type: "member_removed"; workspaceId: string; userId: string }
  | { type: "invite_received"; invite: WorkspaceInvite }
  | { type: "pong" }
  | { type: "error"; message: string };
