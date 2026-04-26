import { validateConfig } from "./config-schema.js";
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
// Main entry
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
