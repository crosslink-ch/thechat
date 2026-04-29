import { validateConfig } from "./config-schema.js";
import {
  resolveAllTheChatAccounts,
  type ResolvedTheChatAccount,
} from "./accounts.js";
import type { TheChatChannelConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CheckStatus = "pass" | "fail" | "warn" | "skip";

export interface DoctorCheck {
  name: string;
  status: CheckStatus;
  message: string;
  /** Optional remediation hint shown when status is fail or warn. */
  hint?: string;
}

export interface DoctorResult {
  ok: boolean;
  checks: DoctorCheck[];
}

/** Multi-account doctor result — one per account plus cross-account checks. */
export interface MultiAccountDoctorResult {
  ok: boolean;
  accounts: Array<{
    accountId: string;
    enabled: boolean;
    result: DoctorResult;
  }>;
  crossAccountChecks: DoctorCheck[];
}

export interface DoctorDeps {
  /** Injectable for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Timeout for network checks (ms). Default 5000. */
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

function checkRequiredFields(config: TheChatChannelConfig): DoctorCheck {
  try {
    validateConfig(config);
    return {
      name: "required_fields",
      status: "pass",
      message: "All required config fields are present.",
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      name: "required_fields",
      status: "fail",
      message: msg,
      hint: "Set all required fields in cfg.channels.thechat: baseUrl, botId, botUserId, apiKey, webhookSecret.",
    };
  }
}

function checkBaseUrlFormat(config: TheChatChannelConfig): DoctorCheck {
  const { baseUrl } = config;
  if (!baseUrl) {
    return {
      name: "base_url_format",
      status: "skip",
      message: "baseUrl is empty — skipped.",
    };
  }
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return {
        name: "base_url_format",
        status: "fail",
        message: `baseUrl protocol "${url.protocol}" is not http or https.`,
        hint: "Use an http:// or https:// URL for baseUrl.",
      };
    }
    if (url.protocol === "http:") {
      return {
        name: "base_url_format",
        status: "warn",
        message: "baseUrl uses http:// — webhook payloads will be unencrypted in transit.",
        hint: "Use https:// in production.",
      };
    }
    return {
      name: "base_url_format",
      status: "pass",
      message: `baseUrl ${baseUrl} is a valid HTTPS URL.`,
    };
  } catch {
    return {
      name: "base_url_format",
      status: "fail",
      message: `baseUrl "${baseUrl}" is not a valid URL.`,
      hint: "Provide a valid URL including the protocol, e.g. https://thechat.example.com",
    };
  }
}

function checkKeyFormats(config: TheChatChannelConfig): DoctorCheck {
  const issues: string[] = [];
  if (config.apiKey && !config.apiKey.startsWith("bot_")) {
    issues.push('apiKey does not start with "bot_" — may be a user token instead of a bot key');
  }
  if (config.webhookSecret && !config.webhookSecret.startsWith("whsec_")) {
    issues.push('webhookSecret does not start with "whsec_" — may be a wrong credential');
  }
  if (issues.length === 0) {
    return {
      name: "key_formats",
      status: "pass",
      message: "API key and webhook secret have expected prefixes.",
    };
  }
  return {
    name: "key_formats",
    status: "warn",
    message: issues.join("; "),
    hint: "Bot API keys start with bot_ and webhook secrets start with whsec_. Regenerate via POST /bots/:id/regenerate-key or /regenerate-secret.",
  };
}

function checkWebhookSecretStrength(config: TheChatChannelConfig): DoctorCheck {
  const { webhookSecret } = config;
  if (!webhookSecret) {
    return {
      name: "webhook_secret_strength",
      status: "skip",
      message: "webhookSecret is empty — skipped.",
    };
  }
  // Strip known prefix for length check.
  const raw = webhookSecret.startsWith("whsec_")
    ? webhookSecret.slice(6)
    : webhookSecret;
  if (raw.length < 16) {
    return {
      name: "webhook_secret_strength",
      status: "warn",
      message: `webhookSecret is only ${raw.length} characters (excluding prefix) — should be ≥ 16 for brute-force resistance.`,
      hint: "Regenerate the webhook secret via POST /bots/:id/regenerate-secret.",
    };
  }
  return {
    name: "webhook_secret_strength",
    status: "pass",
    message: "webhookSecret has adequate length.",
  };
}

async function checkConnectivity(
  config: TheChatChannelConfig,
  deps: DoctorDeps
): Promise<DoctorCheck> {
  if (!config.baseUrl) {
    return {
      name: "connectivity",
      status: "skip",
      message: "baseUrl is empty — skipped connectivity check.",
    };
  }

  const fetcher = deps.fetchImpl ?? globalThis.fetch;
  const timeoutMs = deps.timeoutMs ?? 5000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const base = config.baseUrl.replace(/\/+$/, "");
    // Probe a lightweight, unauthenticated endpoint.  Most ElysiaJS apps
    // respond to GET / or GET /health; we just need a TCP + HTTP roundtrip.
    const res = await fetcher(`${base}/`, {
      method: "GET",
      signal: controller.signal,
      headers: { "User-Agent": "openclaw-channel-thechat-doctor/0.1" },
    });
    return {
      name: "connectivity",
      status: "pass",
      message: `TheChat API at ${base} reachable (HTTP ${res.status}).`,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const aborted = controller.signal.aborted;
    return {
      name: "connectivity",
      status: "fail",
      message: aborted
        ? `TheChat API at ${config.baseUrl} timed out after ${timeoutMs}ms.`
        : `Cannot reach TheChat API at ${config.baseUrl}: ${msg}`,
      hint: "Verify baseUrl is correct and the API server is running.",
    };
  } finally {
    clearTimeout(timer);
  }
}

async function checkBotCredentials(
  config: TheChatChannelConfig,
  deps: DoctorDeps
): Promise<DoctorCheck> {
  if (!config.baseUrl || !config.apiKey) {
    return {
      name: "bot_credentials",
      status: "skip",
      message: "baseUrl or apiKey is empty — skipped credential check.",
    };
  }

  const fetcher = deps.fetchImpl ?? globalThis.fetch;
  const timeoutMs = deps.timeoutMs ?? 5000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const base = config.baseUrl.replace(/\/+$/, "");
    const res = await fetcher(`${base}/auth/me`, {
      method: "GET",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "User-Agent": "openclaw-channel-thechat-doctor/0.1",
      },
    });
    if (res.ok) {
      return {
        name: "bot_credentials",
        status: "pass",
        message: "Bot API key is valid (authenticated against /auth/me).",
      };
    }
    return {
      name: "bot_credentials",
      status: "fail",
      message: `Bot API key rejected: HTTP ${res.status}.`,
      hint: "Regenerate the bot API key via POST /bots/:id/regenerate-key.",
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      name: "bot_credentials",
      status: "fail",
      message: `Credential check failed: ${msg}`,
      hint: "Ensure the API server is reachable and the apiKey is correct.",
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Single-account entry (backward compat)
// ---------------------------------------------------------------------------

/**
 * Run all diagnostic checks against the provided config. Checks are
 * classified as pass/fail/warn/skip. The top-level `ok` is `true` only when
 * no check returned `fail`.
 *
 * Network-dependent checks (connectivity, credentials) use the injected
 * `fetchImpl` so they can be fully unit-tested without a running server.
 */
export async function runDoctorChecks(
  config: TheChatChannelConfig,
  deps: DoctorDeps = {}
): Promise<DoctorResult> {
  // Synchronous checks first.
  const checks: DoctorCheck[] = [
    checkRequiredFields(config),
    checkBaseUrlFormat(config),
    checkKeyFormats(config),
    checkWebhookSecretStrength(config),
  ];

  // Network checks — only run if required fields pass.
  const fieldsOk = checks[0].status === "pass";
  if (fieldsOk) {
    checks.push(await checkConnectivity(config, deps));
    // Only check credentials if connectivity passed.
    const connectivityOk = checks[checks.length - 1].status === "pass";
    if (connectivityOk) {
      checks.push(await checkBotCredentials(config, deps));
    } else {
      checks.push({
        name: "bot_credentials",
        status: "skip",
        message: "Skipped — connectivity check did not pass.",
      });
    }
  } else {
    checks.push({
      name: "connectivity",
      status: "skip",
      message: "Skipped — required fields are missing.",
    });
    checks.push({
      name: "bot_credentials",
      status: "skip",
      message: "Skipped — required fields are missing.",
    });
  }

  return {
    ok: checks.every((c) => c.status !== "fail"),
    checks,
  };
}

// ---------------------------------------------------------------------------
// Multi-account doctor (Phase 3)
// ---------------------------------------------------------------------------

/**
 * Cross-account checks that validate consistency between accounts.
 */
function checkCrossAccount(
  accounts: ResolvedTheChatAccount[]
): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const configured = accounts.filter((a) => a.configured);

  if (configured.length === 0) {
    checks.push({
      name: "cross_account_count",
      status: "warn",
      message: "No fully configured accounts found.",
      hint: "Configure at least one account under cfg.channels.thechat or cfg.channels.thechat.accounts.<id>.",
    });
    return checks;
  }

  checks.push({
    name: "cross_account_count",
    status: "pass",
    message: `${configured.length} configured account(s) found.`,
  });

  // Check for duplicate botId across accounts (would cause inbound routing
  // ambiguity).
  const botIdMap = new Map<string, string[]>();
  for (const a of configured) {
    const ids = botIdMap.get(a.config.botId) ?? [];
    ids.push(a.accountId);
    botIdMap.set(a.config.botId, ids);
  }
  const dupes = Array.from(botIdMap.entries()).filter(([_, ids]) => ids.length > 1);
  if (dupes.length > 0) {
    const detail = dupes
      .map(([botId, ids]) => `botId "${botId}" used by accounts: ${ids.join(", ")}`)
      .join("; ");
    checks.push({
      name: "cross_account_unique_bot_ids",
      status: "fail",
      message: `Duplicate botId across accounts: ${detail}`,
      hint: "Each account must use a distinct bot. Create a separate bot for each account.",
    });
  } else {
    checks.push({
      name: "cross_account_unique_bot_ids",
      status: "pass",
      message: "All configured accounts use unique botIds.",
    });
  }

  // Check for duplicate webhookSecret across accounts (would be a security
  // misconfiguration).
  const secretMap = new Map<string, string[]>();
  for (const a of configured) {
    const ids = secretMap.get(a.config.webhookSecret) ?? [];
    ids.push(a.accountId);
    secretMap.set(a.config.webhookSecret, ids);
  }
  const secretDupes = Array.from(secretMap.entries()).filter(
    ([_, ids]) => ids.length > 1
  );
  if (secretDupes.length > 0) {
    const detail = secretDupes
      .map(([_, ids]) => `accounts sharing a secret: ${ids.join(", ")}`)
      .join("; ");
    checks.push({
      name: "cross_account_unique_secrets",
      status: "warn",
      message: `Shared webhookSecret detected: ${detail}`,
      hint: "Each account should use its own webhookSecret for isolation. Regenerate via POST /bots/:id/regenerate-secret.",
    });
  } else {
    checks.push({
      name: "cross_account_unique_secrets",
      status: "pass",
      message: "All configured accounts use unique webhook secrets.",
    });
  }

  return checks;
}

/**
 * Run doctor checks for all configured accounts plus cross-account
 * consistency checks. Returns per-account results plus the cross-account
 * checks. The top-level `ok` is true only when no check across all accounts
 * and cross-account checks returned `fail`.
 */
export async function runMultiAccountDoctorChecks(
  cfg: unknown,
  deps: DoctorDeps = {}
): Promise<MultiAccountDoctorResult> {
  const allAccounts = resolveAllTheChatAccounts(cfg as any);

  const accountResults = await Promise.all(
    allAccounts.map(async (a) => ({
      accountId: a.accountId,
      enabled: a.enabled,
      result: await runDoctorChecks(a.config, deps),
    }))
  );

  const crossAccountChecks = checkCrossAccount(allAccounts);

  const allOk =
    accountResults.every((a) => a.result.ok) &&
    crossAccountChecks.every((c) => c.status !== "fail");

  return {
    ok: allOk,
    accounts: accountResults,
    crossAccountChecks,
  };
}
