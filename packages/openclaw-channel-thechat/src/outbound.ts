import { parseTarget } from "./session.js";
import type {
  TheChatChannelConfig,
  OutboundRichMessage,
  OutboundAttachment,
} from "./types.js";

export interface SendTextResult {
  /** The TheChat-assigned message id. */
  messageId: string;
  /** Conversation that received the message. */
  conversationId: string;
}

export interface PreparedRequest {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: string;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function resolveConversationId(to: string): string {
  const parsed = parseTarget(to);
  if (!parsed) {
    throw new Error(
      `thechat outbound: target "${to}" is not a TheChat conversation id`
    );
  }
  return parsed.conversationId;
}

function baseHeaders(config: TheChatChannelConfig): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${config.apiKey}`,
    "User-Agent": "openclaw-channel-thechat/0.1",
  };
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

// ---------------------------------------------------------------------------
// Plain text (Phase 1)
// ---------------------------------------------------------------------------

/**
 * Build the HTTP request that will deliver `text` to a TheChat conversation.
 * Pure function so the wire shape can be unit-tested without touching the
 * network.
 */
export function buildSendTextRequest(args: {
  config: TheChatChannelConfig;
  to: string;
  text: string;
}): PreparedRequest {
  const { config, to, text } = args;
  const conversationId = resolveConversationId(to);
  const trimmedText = text.trim();
  if (trimmedText.length === 0) {
    throw new Error("thechat outbound: cannot send an empty message");
  }
  const base = normalizeBaseUrl(config.baseUrl);
  return {
    url: `${base}/messages/${conversationId}`,
    method: "POST",
    headers: baseHeaders(config),
    body: JSON.stringify({ content: trimmedText }),
  };
}

// ---------------------------------------------------------------------------
// Rich messages (Phase 3)
// ---------------------------------------------------------------------------

/**
 * Validate an attachment has the minimum required fields.
 */
function validateAttachment(a: OutboundAttachment, idx: number): void {
  if (!a.mimeType || typeof a.mimeType !== "string") {
    throw new Error(`thechat outbound: attachment[${idx}] missing mimeType`);
  }
  if (!a.url || typeof a.url !== "string") {
    throw new Error(`thechat outbound: attachment[${idx}] missing url`);
  }
  if (!a.filename || typeof a.filename !== "string") {
    throw new Error(`thechat outbound: attachment[${idx}] missing filename`);
  }
}

/**
 * Build the HTTP request for a rich message (text + attachments + metadata).
 * Pure function for testability.
 */
export function buildSendRichMessageRequest(args: {
  config: TheChatChannelConfig;
  to: string;
  message: OutboundRichMessage;
}): PreparedRequest {
  const { config, to, message } = args;
  const conversationId = resolveConversationId(to);
  const trimmedContent = message.content.trim();
  if (trimmedContent.length === 0 && !message.attachments?.length) {
    throw new Error(
      "thechat outbound: rich message must have content or at least one attachment"
    );
  }

  if (message.attachments) {
    message.attachments.forEach((a, i) => validateAttachment(a, i));
  }

  const base = normalizeBaseUrl(config.baseUrl);

  const payload: Record<string, unknown> = { content: trimmedContent };
  if (message.attachments && message.attachments.length > 0) {
    payload.attachments = message.attachments.map((a) => ({
      mimeType: a.mimeType,
      url: a.url,
      filename: a.filename,
      ...(a.sizeBytes !== undefined && { sizeBytes: a.sizeBytes }),
      ...(a.alt !== undefined && { alt: a.alt }),
    }));
  }
  if (message.ephemeral) {
    payload.ephemeral = true;
  }
  if (message.replyTo) {
    payload.replyTo = message.replyTo;
  }

  return {
    url: `${base}/messages/${conversationId}`,
    method: "POST",
    headers: baseHeaders(config),
    body: JSON.stringify(payload),
  };
}

// ---------------------------------------------------------------------------
// Network senders
// ---------------------------------------------------------------------------

export interface SendTextDeps {
  /** Injectable for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

async function executeRequest(
  req: PreparedRequest,
  to: string,
  fetchImpl: typeof fetch
): Promise<SendTextResult> {
  const res = await fetchImpl(req.url, {
    method: req.method,
    headers: req.headers,
    body: req.body,
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(
      `thechat outbound: HTTP ${res.status} sending to ${to}: ${errBody.slice(0, 200)}`
    );
  }
  const data = (await res.json().catch(() => ({}))) as {
    id?: string;
    conversationId?: string;
  };
  if (!data.id || !data.conversationId) {
    throw new Error(
      `thechat outbound: malformed response from TheChat (missing id/conversationId)`
    );
  }
  return { messageId: data.id, conversationId: data.conversationId };
}

/**
 * Deliver a single text message to a TheChat conversation. Throws on
 * non-2xx responses.
 */
export async function sendText(
  args: { config: TheChatChannelConfig; to: string; text: string } & SendTextDeps
): Promise<SendTextResult> {
  const { config, to, text, fetchImpl = fetch } = args;
  const req = buildSendTextRequest({ config, to, text });
  return executeRequest(req, to, fetchImpl);
}

/**
 * Deliver a rich message (text + attachments + metadata) to a TheChat
 * conversation. Throws on non-2xx responses.
 */
export async function sendRichMessage(
  args: {
    config: TheChatChannelConfig;
    to: string;
    message: OutboundRichMessage;
  } & SendTextDeps
): Promise<SendTextResult> {
  const { config, to, message, fetchImpl = fetch } = args;
  const req = buildSendRichMessageRequest({ config, to, message });
  return executeRequest(req, to, fetchImpl);
}
