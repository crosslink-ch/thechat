import type { TheChatChannelConfig } from "./types.js";

/**
 * Multi-account support for TheChat channel plugin.
 *
 * Two config shapes are supported:
 *
 *   **Flat (Phase 1 compat):**
 *     `cfg.channels.thechat.baseUrl = "…"`
 *
 *   **Multi-account (Phase 3):**
 *     `cfg.channels.thechat.accounts.staging.baseUrl = "…"`
 *     `cfg.channels.thechat.accounts.production.baseUrl = "…"`
 *
 * When a flat config is present (any required field directly under
 * `channels.thechat`), it is surfaced as the `"default"` account.  Named
 * accounts under `channels.thechat.accounts.<id>` are independent and can
 * each point at a different TheChat instance / bot.
 *
 * Both shapes can coexist: a flat default plus named accounts.
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

// ---------------------------------------------------------------------------
// Config shape reading
// ---------------------------------------------------------------------------

type AccountSection = Partial<TheChatChannelConfig> & { enabled?: boolean };

interface OpenClawConfigShape {
  channels?: {
    thechat?: AccountSection & {
      accounts?: Record<string, AccountSection>;
    };
  };
}

function asConfigShape(
  cfg: unknown | null | undefined
): OpenClawConfigShape | null | undefined {
  return cfg as OpenClawConfigShape | null | undefined;
}

function isPopulatedString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function readFlatSection(
  cfg: unknown | null | undefined
): AccountSection {
  return asConfigShape(cfg)?.channels?.thechat ?? {};
}

function readNamedAccountSection(
  cfg: unknown | null | undefined,
  accountId: string
): AccountSection {
  return asConfigShape(cfg)?.channels?.thechat?.accounts?.[accountId] ?? {};
}

function hasAnyRequiredField(section: AccountSection): boolean {
  return REQUIRED_FIELDS.some((k) => isPopulatedString(section[k]));
}

function isFullyConfigured(section: AccountSection): boolean {
  return REQUIRED_FIELDS.every((k) => isPopulatedString(section[k]));
}

function sectionToConfig(section: AccountSection): TheChatChannelConfig {
  return {
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
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * List all account ids that have at least one required field set.
 * Always includes `"default"` when flat config is present.
 */
export function listTheChatAccountIds(
  cfg: unknown | null | undefined
): string[] {
  const ids: string[] = [];
  const shaped = asConfigShape(cfg);

  // Flat → "default"
  const flat = readFlatSection(cfg);
  if (hasAnyRequiredField(flat)) {
    ids.push(DEFAULT_ACCOUNT_ID);
  }

  // Named accounts under channels.thechat.accounts.*
  const accounts = shaped?.channels?.thechat?.accounts;
  if (accounts && typeof accounts === "object") {
    for (const id of Object.keys(accounts)) {
      if (hasAnyRequiredField(accounts[id])) {
        ids.push(id);
      }
    }
  }

  return ids;
}

/**
 * Return the default account id.  When named accounts exist but no flat
 * config, falls back to the first named account.
 */
export function resolveDefaultTheChatAccountId(
  cfg: unknown | null | undefined
): string {
  const shaped = asConfigShape(cfg);
  const flat = readFlatSection(cfg);
  if (hasAnyRequiredField(flat)) return DEFAULT_ACCOUNT_ID;

  const accounts = shaped?.channels?.thechat?.accounts;
  if (accounts && typeof accounts === "object") {
    const first = Object.keys(accounts).find((id) =>
      hasAnyRequiredField(accounts[id])
    );
    if (first) return first;
  }

  return DEFAULT_ACCOUNT_ID;
}

/**
 * Resolve a specific account by id.
 *
 * - `null` / `undefined` → configured default account
 * - `"default"` → flat config at `channels.thechat`
 * - Any other string → named account at `channels.thechat.accounts.<id>`
 */
export function resolveTheChatAccount(params: {
  cfg: unknown | null | undefined;
  accountId?: string | null;
}): ResolvedTheChatAccount {
  const { cfg, accountId } = params;
  const effectiveAccountId = accountId ?? resolveDefaultTheChatAccountId(cfg);
  const isDefault = effectiveAccountId === DEFAULT_ACCOUNT_ID;

  const section = isDefault
    ? readFlatSection(cfg)
    : readNamedAccountSection(cfg, effectiveAccountId);

  const enabled = section.enabled !== false;
  const configured = isFullyConfigured(section);
  const config = sectionToConfig(section);

  return {
    accountId: isDefault ? DEFAULT_ACCOUNT_ID : effectiveAccountId,
    enabled,
    configured,
    name: section.botName,
    config,
  };
}

/**
 * Resolve all configured accounts. Useful for doctor checks that need to
 * validate every account.
 */
export function resolveAllTheChatAccounts(
  cfg: unknown | null | undefined
): ResolvedTheChatAccount[] {
  const ids = listTheChatAccountIds(cfg);
  return ids.map((id) => resolveTheChatAccount({ cfg, accountId: id }));
}

/**
 * Find which account owns a given `botId`. Used by the inbound webhook
 * handler to route payloads to the correct account in multi-account setups.
 */
export function findAccountByBotId(
  cfg: unknown | null | undefined,
  botId: string
): ResolvedTheChatAccount | null {
  const accounts = resolveAllTheChatAccounts(cfg);
  return (
    accounts.find(
      (a) => a.enabled && a.configured && a.config.botId === botId
    ) ?? null
  );
}
