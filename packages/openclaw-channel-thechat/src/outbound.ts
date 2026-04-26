import { parseTarget } from "./session.js";
import type { TheChatChannelConfig } from "./types.js";

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
  const parsed = parseTarget(to);
  if (!parsed) {
    throw new Error(
      `thechat outbound: target "${to}" is not a TheChat conversation id`
    );
  }
  const trimmedText = text.trim();
  if (trimmedText.length === 0) {
    throw new Error("thechat outbound: cannot send an empty message");
  }
  // Strip trailing slashes from baseUrl so we don't end up with `//messages`.
  const base = config.baseUrl.replace(/\/+$/, "");
  return {
    url: `${base}/messages/${parsed.conversationId}`,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
      "User-Agent": "openclaw-channel-thechat/0.1",
    },
    body: JSON.stringify({ content: trimmedText }),
  };
}

export interface SendTextDeps {
  /** Injectable for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
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
