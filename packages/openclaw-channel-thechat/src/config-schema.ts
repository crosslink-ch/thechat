import type { TheChatChannelConfig } from "./types.js";

export type ResolvedConfig = TheChatChannelConfig;

/**
 * Lightweight runtime validator for `channels.thechat.<account>.config`.
 *
 * We deliberately don't pull in `zod` or `typebox` so this package can be
 * loaded inside an OpenClaw setup-entry path that needs to stay
 * import-cheap. The JSON schema in `openclaw.plugin.json` is the source of
 * truth; this helper just hard-fails when required fields are missing so
 * runtime errors surface at boot rather than during the first webhook.
 */
export function validateConfig(input: unknown): ResolvedConfig {
  if (!input || typeof input !== "object") {
    throw new Error("thechat: config must be an object");
  }
  const c = input as Record<string, unknown>;

  const required = [
    "baseUrl",
    "botId",
    "botUserId",
    "apiKey",
    "webhookSecret",
  ] as const;
  for (const key of required) {
    if (typeof c[key] !== "string" || (c[key] as string).length === 0) {
      throw new Error(`thechat: missing required string field "${key}"`);
    }
  }

  if (
    c.maxClockSkewSeconds !== undefined &&
    (typeof c.maxClockSkewSeconds !== "number" || c.maxClockSkewSeconds < 5)
  ) {
    throw new Error(
      "thechat: maxClockSkewSeconds must be a number >= 5 if provided"
    );
  }

  if (c.allowFrom !== undefined && !Array.isArray(c.allowFrom)) {
    throw new Error("thechat: allowFrom must be an array of user ids");
  }

  if (
    c.requireMentionInChannels !== undefined &&
    typeof c.requireMentionInChannels !== "boolean"
  ) {
    throw new Error("thechat: requireMentionInChannels must be boolean");
  }

  if (
    c.allowOtherBots !== undefined &&
    typeof c.allowOtherBots !== "boolean"
  ) {
    throw new Error("thechat: allowOtherBots must be boolean");
  }

  return {
    baseUrl: c.baseUrl as string,
    botId: c.botId as string,
    botUserId: c.botUserId as string,
    botName: typeof c.botName === "string" ? c.botName : undefined,
    apiKey: c.apiKey as string,
    webhookSecret: c.webhookSecret as string,
    maxClockSkewSeconds: c.maxClockSkewSeconds as number | undefined,
    requireMentionInChannels: c.requireMentionInChannels as boolean | undefined,
    allowFrom: c.allowFrom as string[] | undefined,
    allowOtherBots: c.allowOtherBots as boolean | undefined,
  };
}
