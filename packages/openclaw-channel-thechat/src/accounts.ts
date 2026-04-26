import type { TheChatChannelConfig } from "./types.js";

/**
 * Phase 1 only supports a single default account at `cfg.channels.thechat`.
 * Multi-account support (`cfg.channels.thechat.accounts.<id>`) can be added
 * later by widening the read path here without touching the channel plugin
 * surface.
 */
export const DEFAULT_ACCOUNT_ID = "default";

const REQUIRED_FIELDS: ReadonlyArray<keyof TheChatChannelConfig> = [
  "baseUrl",
  "botId",
  "botUserId",
  "apiKey",
  "webhookSecret",
];

export interface ResolvedTheChatAccount {
  accountId: string;
  enabled: boolean;
  configured: boolean;
  name?: string;
  config: TheChatChannelConfig;
}

interface OpenClawConfigShape {
  channels?: {
    thechat?: Partial<TheChatChannelConfig> & { enabled?: boolean };
  };
}

function readChannelSection(
  cfg: OpenClawConfigShape | null | undefined
): Partial<TheChatChannelConfig> & { enabled?: boolean } {
  return cfg?.channels?.thechat ?? {};
}

function isPopulatedString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

export function listTheChatAccountIds(
  cfg: OpenClawConfigShape | null | undefined
): string[] {
  const section = readChannelSection(cfg);
  // Surface the default account id whenever any TheChat config is present so
  // doctor and `channels list` don't silently hide an in-progress account.
  const hasAnyField = REQUIRED_FIELDS.some((k) => isPopulatedString(section[k]));
  return hasAnyField ? [DEFAULT_ACCOUNT_ID] : [];
}

export function resolveDefaultTheChatAccountId(
  _cfg: OpenClawConfigShape | null | undefined
): string {
  return DEFAULT_ACCOUNT_ID;
}

export function resolveTheChatAccount(params: {
  cfg: OpenClawConfigShape | null | undefined;
  accountId?: string | null;
}): ResolvedTheChatAccount {
  const section = readChannelSection(params.cfg);
  const enabled = section.enabled !== false;
  const configured = REQUIRED_FIELDS.every((k) => isPopulatedString(section[k]));
  const config: TheChatChannelConfig = {
    baseUrl: section.baseUrl ?? "",
    botId: section.botId ?? "",
    botUserId: section.botUserId ?? "",
    botName: section.botName,
    apiKey: section.apiKey ?? "",
    webhookSecret: section.webhookSecret ?? "",
    maxClockSkewSeconds: section.maxClockSkewSeconds,
    requireMentionInChannels: section.requireMentionInChannels,
    allowFrom: section.allowFrom,
    allowOtherBots: section.allowOtherBots,
  };
  return {
    accountId: DEFAULT_ACCOUNT_ID,
    enabled,
    configured,
    name: section.botName,
    config,
  };
}
