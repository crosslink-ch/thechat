import type { TheChatChannelConfig, TheChatWebhookPayload } from "./types.js";

export type GateDecision =
  | { dispatch: true }
  | {
      dispatch: false;
      reason:
        | "own_message"
        | "other_bot_blocked"
        | "sender_not_allowed"
        | "channel_mention_required"
        | "unknown_event";
    };

/**
 * Decide whether OpenClaw should react to a TheChat webhook payload.
 *
 * Rules, in order:
 *   1. Drop messages authored by the bot itself (TheChat already enforces
 *      this server-side, but we double-check to defend against config drift
 *      or replay).
 *   2. Drop messages from other bots unless `allowOtherBots` is set — primary
 *      defense against bot-to-bot loops once multiple OpenClaw instances or
 *      cross-platform bridges are wired up.
 *   3. Enforce per-bot allowlist (TheChat user ids). Empty / missing list
 *      means "allow everyone".
 *   4. For group channels, require an @mention unless the operator has
 *      explicitly relaxed `requireMentionInChannels`. DMs always pass.
 */
export function shouldDispatch(
  payload: TheChatWebhookPayload,
  config: TheChatChannelConfig
): GateDecision {
  const {
    botUserId,
    allowFrom = [],
    allowOtherBots = false,
    requireMentionInChannels = true,
  } = config;

  // Defense-in-depth own-message check. The TheChat server already filters
  // these, but the plugin must still be safe against a misconfigured
  // upstream that fans the bot's own messages back at it.
  if (payload.message.senderId === botUserId) {
    return { dispatch: false, reason: "own_message" };
  }

  if (payload.message.senderType === "bot" && !allowOtherBots) {
    return { dispatch: false, reason: "other_bot_blocked" };
  }

  if (allowFrom.length > 0 && !allowFrom.includes(payload.message.senderId)) {
    return { dispatch: false, reason: "sender_not_allowed" };
  }

  if (payload.event === "direct_message") {
    return { dispatch: true };
  }

  if (payload.event === "mention") {
    // Channel kind is "channel" by construction in TheChat, but be defensive.
    if (payload.conversation.kind !== "channel") {
      return { dispatch: true };
    }
    if (!requireMentionInChannels) {
      return { dispatch: true };
    }
    // The webhook is itself a mention event — no further gating needed.
    return { dispatch: true };
  }

  return { dispatch: false, reason: "unknown_event" };
}
