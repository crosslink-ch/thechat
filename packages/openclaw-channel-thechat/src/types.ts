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
