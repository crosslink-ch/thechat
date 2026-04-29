/**
 * Local copies of the TheChat webhook payload types.
 *
 * The plugin publishes as a standalone npm package, so it can't depend on
 * `@thechat/shared` at runtime when installed by an OpenClaw operator who is
 * NOT running the TheChat monorepo. Inside the monorepo we re-export the
 * shared types verbatim through `./types-shared` so they stay in lockstep
 * during development; downstream consumers can import the structurally
 * equivalent types from this file.
 */

export type WebhookEventType = "mention" | "direct_message";

export interface WebhookMessage {
  id: string;
  content: string;
  conversationId: string;
  senderId: string;
  senderName: string;
  senderType: "human" | "bot";
  createdAt: string;
}

export interface WebhookConversation {
  id: string;
  type: "direct" | "group";
  kind: "dm" | "channel";
  name: string | null;
  workspaceId: string | null;
}

export interface WebhookWorkspace {
  id: string;
  name: string;
}

export interface WebhookBot {
  id: string;
  userId: string;
  name: string;
}

export interface TheChatWebhookPayload {
  event: WebhookEventType;
  message: WebhookMessage;
  conversation: WebhookConversation;
  workspace: WebhookWorkspace | null;
  bot: WebhookBot;
}

export interface TheChatChannelConfig {
  /** Base URL of the TheChat API, e.g. `https://thechat.example.com`. */
  baseUrl: string;
  /** Bot row id (returned by POST /bots/create). */
  botId: string;
  /** User id backing the bot — used for own-message loop prevention. */
  botUserId: string;
  /** Display name of the bot. Optional; only used in logs. */
  botName?: string;
  /** Bot API key (Bearer token) used for outbound message sends. */
  apiKey: string;
  /** HMAC shared secret used to verify inbound webhook signatures. */
  webhookSecret: string;
  /** Replay-protection window in seconds. Defaults to 300. */
  maxClockSkewSeconds?: number;
  /** Group channels require an @mention to dispatch (default true). */
  requireMentionInChannels?: boolean;
  /** Allowlist of TheChat user ids permitted to message the bot. */
  allowFrom?: string[];
  /** Whether to dispatch messages from other bots. Default false (loop prevention). */
  allowOtherBots?: boolean;
}

// ---------------------------------------------------------------------------
// Rich message types (Phase 3)
// ---------------------------------------------------------------------------

/**
 * Attachment metadata for outbound messages. The TheChat API stores
 * attachment records alongside the message; the actual file is referenced
 * by URL (pre-signed or public) rather than inline binary.
 */
export interface OutboundAttachment {
  /** MIME type, e.g. `image/png`, `application/pdf`. */
  mimeType: string;
  /** URL where the file can be fetched. */
  url: string;
  /** Human-readable filename shown in the UI. */
  filename: string;
  /** File size in bytes (used for display; not validated server-side). */
  sizeBytes?: number;
  /** Alt text or summary for accessibility. */
  alt?: string;
}

/**
 * Structured outbound message. Extends plain text with optional
 * attachments and formatting hints. The `content` field is always
 * Markdown-formatted text — TheChat renders it with CommonMark.
 */
export interface OutboundRichMessage {
  /** Markdown-formatted text body. */
  content: string;
  /** Optional attachments. */
  attachments?: OutboundAttachment[];
  /** If true, the message is only visible to the sender ("ephemeral"). */
  ephemeral?: boolean;
  /** Optional thread/reply-to message id. */
  replyTo?: string;
}
