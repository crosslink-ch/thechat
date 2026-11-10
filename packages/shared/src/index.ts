import type { BotAppearance } from "./bot-avatars";

export * from "./bot-avatars";
export * from "./secure-input";
export * from "./search";

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
  user: AuthUser;
}

export interface RegisterResponse {
  accessToken?: string;
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
  bot?: { id: string; kind: BotKind; avatar?: BotAppearance } | null;
}

/** A private channel is run by its own admins, starting with its creator. */
export type ChannelMemberRole = "member" | "admin";

export interface ChannelMember {
  userId: string;
  role: ChannelMemberRole;
}

export interface WorkspaceChannel {
  id: string;
  workspaceId: string;
  name: string;
  title: string | null;
  isPrivate: boolean;
  /**
   * Who is in a private channel, oldest member first. Absent for public
   * channels, which always contain the whole workspace.
   */
  members?: ChannelMember[];
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
  reactions?: MessageReactionSummary[];
  /**
   * Present (true) only on an agent's progress update ("⏳ Working — 5 min").
   * The agent's answer follows in a later message.
   */
  interim?: true;
  /**
   * Set on a reply in a reply thread (Slack-style): the thread's root message.
   * Replies are not part of the conversation's main timeline unless
   * `alsoSentToConversation` is set. Unrelated to `threadId` (a Hermes task).
   */
  parentMessageId?: string | null;
  /** A thread reply that is also shown in the main timeline. */
  alsoSentToConversation?: true;
  /** Present on a root message that has replies. */
  thread?: MessageThreadSummary;
  createdAt: string;
}

/** What a root message shows about its replies ("3 replies · Last reply 5m ago"). */
export interface MessageThreadSummary {
  replyCount: number;
  lastReplyAt: string;
  /** People who replied, most recent first (at most 5). */
  participants: { id: string; name: string; type: "human" | "bot" }[];
}

/** A reply thread opened in the side panel. */
export interface MessageThreadPage {
  root: ChatMessage;
  /** Chronological. */
  replies: ChatMessage[];
  /** Earlier replies exist; page with `before` = the first reply's createdAt. */
  hasOlder: boolean;
  /** The signed-in user follows the thread (gets unread state and notifications). */
  following: boolean;
  /** Unread replies captured before the page was read. */
  unreadMessageIds: string[];
}

/** One followed thread in the Threads view. */
export interface FollowedThread {
  conversationId: string;
  conversationType: "direct" | "group";
  /** Channel name, or the other person's name for a direct conversation. */
  conversationName: string;
  workspaceId: string;
  workspaceName: string;
  root: ChatMessage;
  /** The newest replies, chronological (at most 3). */
  latestReplies: ChatMessage[];
  replyCount: number;
  unreadCount: number;
  lastReplyAt: string;
}

export interface FollowedThreadsPage {
  items: FollowedThread[];
  /** Pass back as `before` for older threads; null when exhausted. */
  nextCursor: string | null;
}

/** First task/General page plus the exact unread backlog captured before it. */
export interface TaskMessagePage {
  messages: ChatMessage[];
  unreadMessageIds: string[];
}

// -- Search --

/** One message that matched a search, with enough context to show and open it. */
export interface MessageSearchHit {
  id: string;
  conversationId: string;
  conversationType: "direct" | "group";
  /** Channel name, or the other participant's name for a direct conversation. */
  conversationName: string;
  workspaceId: string;
  workspaceName: string;
  threadId: string | null;
  threadTitle: string | null;
  /** Set when the match is a reply in a reply thread: the thread's root. */
  parentMessageId?: string | null;
  senderId: string;
  senderName: string;
  senderType: "human" | "bot";
  /** Plain-text excerpt around the first match. */
  snippet: string;
  createdAt: string;
}

export interface MessageSearchPage {
  results: MessageSearchHit[];
  /** Pass back as `cursor` for the next (older) page; null when exhausted. */
  nextCursor: string | null;
}

/** A place the quick switcher can jump to. */
export type SearchDestination =
  | {
      kind: "channel";
      conversationId: string;
      name: string;
      workspaceId: string;
      workspaceName: string;
    }
  | {
      kind: "person";
      userId: string;
      name: string;
      userType: "human" | "bot";
      botKind: BotKind | null;
      botAvatar: BotAppearance | null;
      workspaceId: string;
      workspaceName: string;
      /** The existing direct conversation, when there is one. */
      conversationId: string | null;
    }
  | {
      /** A Hermes task, opened inside its DM. */
      kind: "task";
      conversationId: string;
      /** The bot's name. */
      conversationName: string;
      threadId: string;
      title: string;
      workspaceId: string;
      workspaceName: string;
      lastActivityAt: string;
    };

/** Messages around one message, in the scope the conversation shows them. */
export interface MessageContext {
  conversation: {
    id: string;
    type: "direct" | "group";
    name: string;
    workspaceId: string;
    workspaceName: string;
  };
  /** Task scope of the target (null is General / the whole channel). */
  threadId: string | null;
  threadTitle: string | null;
  /**
   * Set when the target is a reply: the thread's root. The context is then
   * the reply thread (root first), not the conversation's timeline.
   */
  replyRootId?: string | null;
  targetMessageId: string;
  /** Chronological, including the target. */
  messages: ChatMessage[];
  hasOlder: boolean;
  hasNewer: boolean;
}

export interface MessageReactionSummary {
  emoji: string;
  count: number;
  reactedByMe: boolean;
  userNames: string[];
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
  otherBot?: { id: string; kind: BotKind; avatar?: BotAppearance } | null;
  lastMessage: ChatMessage | null;
}

export interface ConversationParticipantPublic {
  userId: string;
  role: WorkspaceMemberRole;
  joinedAt: string;
  user: AuthUser;
  bot?: {
    id: string;
    kind: BotKind;
    avatar?: BotAppearance;
    commands?: BotCommandPublic[] | null;
  } | null;
}

export interface ConversationDetail {
  id: string;
  type: "direct" | "group";
  workspaceId: string | null;
  name: string | null;
  title: string | null;
  isPrivate: boolean;
  participants: ConversationParticipantPublic[];
}

export interface ActivityLatestMessage {
  id: string;
  threadId: string | null;
  threadTitle: string | null;
  senderId: string;
  senderName: string;
  senderType: "human" | "bot";
  content: string;
  createdAt: string;
}

export interface ActivityItem {
  conversationId: string;
  conversationType: "direct" | "group";
  conversationName: string;
  workspaceId: string;
  workspaceName: string;
  unreadCount: number;
  /** All scopes with unread messages; null denotes General. Absent on older servers. */
  unreadThreadIds?: (string | null)[];
  latestMessage: ActivityLatestMessage;
}

/** Unread replies in one followed reply thread. */
export interface ActivityThreadItem {
  conversationId: string;
  conversationType: "direct" | "group";
  conversationName: string;
  workspaceId: string;
  workspaceName: string;
  rootMessageId: string;
  root: {
    senderId: string;
    senderName: string;
    content: string;
    createdAt: string;
  };
  unreadCount: number;
  latestMessage: ActivityLatestMessage;
}

export interface ActivitySnapshot {
  /** Unread messages in conversations' main timelines. */
  items: ActivityItem[];
  /** Unread replies in followed threads. Absent on older servers. */
  threads?: ActivityThreadItem[];
  /** Every unread message, thread replies included. */
  totalUnreadMessages: number;
}

export interface ConversationThreadPublic {
  id: string;
  conversationId: string;
  botId: string;
  title: string;
  status: string;
  branchPending?: boolean;
  branchFromThreadId?: string | null;
  /** The project this task is filed under, or null when it has none. */
  projectId?: string | null;
  createdById: string;
  lastActivityAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationThreadsPage {
  items: ConversationThreadPublic[];
  nextCursor: string | null;
  hasMore: boolean;
  /**
   * Tasks matching the list's filters across all pages. Optional because
   * servers that predate per-project paging do not send it.
   */
  totalCount?: number;
}

/** One task group: a project's tasks, or (projectId null) tasks without one. */
export interface ConversationThreadGroupPage extends ConversationThreadsPage {
  projectId: string | null;
  totalCount: number;
}

/**
 * The first page of every task group in a conversation. Each group is paged
 * separately so a project's tasks never fall behind newer tasks elsewhere.
 */
export interface ConversationThreadGroups {
  groups: ConversationThreadGroupPage[];
}

/** A named group of tasks inside one conversation. */
export interface TaskProjectPublic {
  id: string;
  conversationId: string;
  name: string;
  createdById: string;
  createdAt: string;
  updatedAt: string;
}

export interface TaskProjectDetail {
  project: TaskProjectPublic;
  /** Tasks filed under the project, most recently active first. */
  tasks: ConversationThreadPublic[];
}

// -- WebSocket Event Types --

export type WsClientEvent =
  | { type: "auth"; token: string; mode?: never }
  | { type: "auth"; mode: "cookie"; token?: never }
  | {
      type: "send_message";
      conversationId: string;
      content: string;
      threadId?: string | null;
      parentMessageId?: string | null;
      alsoSendToConversation?: boolean;
      clientMessageId?: string;
      attachmentIds?: string[];
    }
  | {
      type: "typing";
      conversationId: string;
      threadId?: string | null;
      /** Typing in the reply thread of this root message. */
      parentMessageId?: string | null;
    }
  | { type: "ping" };

// -- Bot Types --

export type BotKind = "webhook" | "hermes";

export interface BotWorkspaceMembership {
  id: string;
  name: string;
}

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
  avatar?: BotAppearance;
  attachmentAccess?: boolean;
  webhookUrl: string | null;
  createdAt: string;
}

/** Owner-only bot details returned by the bot-management API. */
export interface OwnedBot extends Bot {
  attachmentAccess: boolean;
  webhookSecret: string;
  apiKeyEnabled: boolean;
  workspaces: BotWorkspaceMembership[];
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

export interface HermesBotConfigPublic {
  botId: string;
  defaultMode: HermesDefaultMode;
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

export interface VaultUnlockRequest {
  version: 2;
  requestId: string;
  sessionKey: string;
  profileId: string;
  backend: "bitwarden";
  requesterUserId: string;
  nonce: string;
  expiresAt: number;
  algorithm: "RSA-OAEP-3072-SHA256+A256GCM";
  publicKeySpkiB64: string;
}

/** Secret ciphertext travels only through the dedicated transient POST. */
export type VaultUnlockResponse =
  | { version: 2; action: "submit"; wrappedKeyB64: string; ivB64: string; ciphertextB64: string }
  | { version: 2; action: "cancel" };

export interface BotRuntimeSnapshot {
  invocations: BotInvocationPublic[];
  events: BotInvocationProgressEventPublic[];
}

// -- Bot request inbox --

/** What a bot asks a human for. TheChat does not interpret the purpose. */
export type BotRequestKind = "approval" | "question" | "review";

/**
 * `answered` means TheChat stored the answer; `delivered` means the bot
 * confirmed it received it (`deliveryApplied` says whether it could use it).
 */
export type BotRequestStatus =
  | "open"
  | "answered"
  | "delivered"
  | "cancelled"
  | "expired";

/**
 * The answers a request accepts. `choice` offers fixed options (optionally
 * several at once, optionally free text as "Other", optionally a comment);
 * `text` accepts free text only.
 */
export interface BotRequestResponseSpec {
  type: "choice" | "text";
  choices?: string[];
  /** Display labels keyed by choice. Missing labels show the choice itself. */
  labels?: Record<string, string>;
  multiple?: boolean;
  allowText?: boolean;
  allowComment?: boolean;
  maxLength?: number;
}

/** Exactly one of `choice`, `choices` or `text`; `comment` is optional. */
export interface BotRequestAnswer {
  choice?: string;
  choices?: string[];
  text?: string;
  comment?: string;
}

export interface BotRequestPublic {
  id: string;
  botId: string;
  botUserId: string;
  botName: string;
  botAvatar?: BotAppearance;
  conversationId: string;
  conversationType: "direct" | "group";
  conversationName: string | null;
  workspaceId: string | null;
  threadId: string | null;
  threadTitle: string | null;
  invocationId: string | null;
  kind: BotRequestKind;
  title: string;
  body: string | null;
  details: Record<string, unknown> | null;
  response: BotRequestResponseSpec;
  /** Requests sharing a group must be answered oldest first. Opaque. */
  orderGroup: string | null;
  audienceUserId: string | null;
  status: BotRequestStatus;
  answer: BotRequestAnswer | null;
  answeredBy: { id: string; name: string } | null;
  answeredAt: string | null;
  deliveredAt: string | null;
  deliveryApplied: boolean | null;
  deliveryNote: string | null;
  cancelReason: string | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** The bot's own view of a request also carries its idempotency key. */
export interface BotRequestBotView extends BotRequestPublic {
  clientKey: string;
}

export interface BotRequestInbox {
  open: BotRequestPublic[];
  recent: BotRequestPublic[];
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

export type BotWorkspaceInviteStatus =
  | "pending"
  | "accepted"
  | "declined"
  | "cancelled";

export interface BotWorkspaceInvite {
  id: string;
  workspaceId: string;
  workspaceName: string;
  botId: string;
  botName: string;
  botAvatar?: BotAppearance;
  requesterId: string;
  requesterName: string;
  status: BotWorkspaceInviteStatus;
  createdAt: string;
}

export type BotWorkspaceInviteResult =
  | { status: "added"; botId: string }
  | { status: "pending"; invite: BotWorkspaceInvite };

export type AppNotification =
  | { type: "workspace_invite"; invite: WorkspaceInvite }
  | { type: "bot_workspace_invite"; invite: BotWorkspaceInvite };

// -- Background (Web Push) notification types --

/** Account-wide choices for notifications delivered while TheChat is closed. */
export interface NotificationPreferences {
  directMessages: boolean;
  mentions: boolean;
  /** Replies from agents (bots) in direct conversations and tasks. */
  agentReplies: boolean;
  /** Approvals, questions and reviews that an agent is waiting on. */
  agentRequests: boolean;
  /**
   * Also an agent's progress updates while it is still working. Off by
   * default: agent replies then notify only for finished work.
   */
  agentProgress: boolean;
  /** Replies in threads you follow. Absent on older servers. */
  threadReplies?: boolean;
  /** Show message text on the lock screen. */
  showPreviews: boolean;
}

export type PushNotificationKind =
  | "direct_message"
  | "mention"
  | "thread_reply"
  | "agent_reply"
  | "agent_progress"
  | "agent_request"
  | "test";

/** The decrypted payload a service worker receives for one notification. */
export interface PushNotificationPayload {
  v: 1;
  /** Stable per notification; the same event never shows twice. */
  id: string;
  kind: PushNotificationKind;
  title: string;
  body: string;
  /** Notifications with the same tag replace each other (one per conversation). */
  tag: string;
  /** App-relative hash route to open, e.g. "#/open?conversationId=...". */
  url: string;
  timestamp: number;
  /** Unread messages for the app icon badge, when known. */
  badge?: number;
}

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

export interface TraceContextCarrier {
  traceparent: string;
  tracestate?: string;
}

export type WsServerEvent =
  | { type: "auth_ok"; userId: string }
  | { type: "auth_error"; message: string; retryable?: boolean }
  | {
      type: "new_message";
      message: ChatMessage;
      conversationType: "direct" | "group";
      clientMessageId?: string;
      /** For a thread reply: the root's updated reply summary. */
      rootThread?: MessageThreadSummary;
      traceContext?: TraceContextCarrier;
    }
  | {
      type: "thread_follow_updated";
      conversationId: string;
      rootMessageId: string;
      following: boolean;
    }
  | {
      type: "message_reactions_updated";
      conversationId: string;
      messageId: string;
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
      type: "bot_request_updated";
      conversationId: string;
      request: BotRequestPublic;
    }
  | {
      type: "conversation_thread_updated";
      conversationId: string;
      thread: ConversationThreadPublic;
    }
  | {
      type: "conversation_thread_deleted";
      conversationId: string;
      threadId: string;
    }
  | {
      type: "task_project_updated";
      conversationId: string;
      project: TaskProjectPublic;
    }
  | {
      type: "task_project_deleted";
      conversationId: string;
      projectId: string;
    }
  | {
      type: "typing";
      conversationId: string;
      threadId: string | null;
      /** Set when typing in a reply thread. */
      parentMessageId?: string | null;
      userId: string;
      userName: string;
    }
  | { type: "member_joined"; workspaceId: string; member: WorkspaceMember }
  | {
      type: "member_role_changed";
      workspaceId: string;
      userId: string;
      newRole: WorkspaceMemberRole;
    }
  | {
      type: "member_updated";
      workspaceId: string;
      userId: string;
      name: string;
      botAvatar?: BotAppearance;
    }
  | { type: "member_removed"; workspaceId: string; userId: string }
  | {
      type: "channel_created";
      workspaceId: string;
      channel: WorkspaceChannel;
    }
  | {
      type: "channel_renamed";
      workspaceId: string;
      channel: WorkspaceChannel;
    }
  | {
      // Visibility or membership changed; sent to everyone still in it.
      type: "channel_updated";
      workspaceId: string;
      channel: WorkspaceChannel;
    }
  | {
      // The receiver was added to a channel that already existed.
      type: "channel_joined";
      workspaceId: string;
      channel: WorkspaceChannel;
    }
  | {
      // Also sent to someone who left or was removed from a private channel.
      type: "channel_deleted";
      workspaceId: string;
      channelId: string;
    }
  | { type: "invite_received"; invite: WorkspaceInvite }
  | { type: "bot_workspace_invite_received"; invite: BotWorkspaceInvite }
  | {
      type: "bot_workspace_invite_resolved";
      inviteId: string;
      workspaceId: string;
      botId: string;
      status: Exclude<BotWorkspaceInviteStatus, "pending">;
    }
  | { type: "presence_snapshot"; userIds: string[] }
  | { type: "presence_changed"; userId: string; online: boolean }
  | { type: "pong" }
  | { type: "error"; message: string };
