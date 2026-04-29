import type { TheChatWebhookPayload } from "./types.js";

export interface SessionMapping {
  /** The OpenClaw "to" / target id used by the shared message tool. */
  to: string;
  /** Stable session key — same conversation always produces the same key. */
  sessionKey: string;
  /** Higher-level chat type. */
  chatType: "direct" | "group";
}

/**
 * Map a TheChat conversation to OpenClaw's session/target grammar.
 *
 * The `to` field is structured `dm:<conversationId>` for DMs and
 * `channel:<conversationId>` for channels. We use the conversation id rather
 * than the workspace + name because it is stable across renames and works
 * for DMs (which have no name).
 *
 * The session key is workspace-scoped so two workspaces hosting the same
 * conversation id (impossible today but cheap to future-proof) wouldn't
 * collide.
 */
export function deriveSessionMapping(
  payload: TheChatWebhookPayload
): SessionMapping {
  const { conversation } = payload;
  const targetPrefix = conversation.kind === "dm" ? "dm" : "channel";
  const to = `${targetPrefix}:${conversation.id}`;
  const workspaceScope = conversation.workspaceId ?? "global";
  const sessionKey = `thechat:${workspaceScope}:${to}`;
  return {
    to,
    sessionKey,
    chatType: conversation.type,
  };
}

/**
 * Reverse mapping: parse a `to` value produced by `deriveSessionMapping`
 * back into a conversation id usable for outbound API calls.
 *
 * Returns null if the input is not a TheChat target.
 */
export function parseTarget(
  to: string
): { kind: "dm" | "channel"; conversationId: string } | null {
  const trimmed = to.trim();
  const match = /^(dm|channel):(.+)$/.exec(trimmed);
  if (!match) return null;
  return {
    kind: match[1] as "dm" | "channel",
    conversationId: match[2],
  };
}
