import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  startDeviceAuth,
  pollDeviceAuth,
  exchangeCodeForTokens,
  refreshAccessToken,
  extractAccountId,
  createBrowserAuthRequest,
} from "../core/codex-auth";
import { error as logError, info as logInfo, formatError } from "../log";
import { ProviderError } from "../core/errors";

type CodexAuthStatus = "idle" | "opening_browser" | "waiting_browser" | "awaiting_code" | "polling" | "authenticated" | "error";
type CodexLoginMethod = "browser" | "device";

interface OAuthCallbackResult {
  code: string;
  state?: string | null;
}

interface CodexAuthState {
  accessToken: string | null;
  refreshToken: string | null;
  accountId: string | null;
  expiresAt: number | null;
  status: CodexAuthStatus;
  userCode: string | null;
  verificationUrl: string;
  browserAuthUrl: string | null;
  error: string | null;

  initialize: () => Promise<void>;
  startLogin: (method?: CodexLoginMethod) => Promise<void>;
  cancelLogin: () => void;
  logout: () => Promise<void>;
  getValidToken: () => Promise<{ accessToken: string; accountId: string }>;
}

let pollAbortController: AbortController | null = null;

const KV_ACCESS_TOKEN = "codex_access_token";
const KV_REFRESH_TOKEN = "codex_refresh_token";
const KV_ACCOUNT_ID = "codex_account_id";
const KV_EXPIRES_AT = "codex_expires_at";

async function persistTokens(tokens: Awaited<ReturnType<typeof exchangeCodeForTokens>>, fallbackAccountId?: string | null) {
  const accountId = extractAccountId(tokens) || fallbackAccountId || "";
  const expiresAt = tokens.expires_in
    ? Date.now() + tokens.expires_in * 1000
    : Date.now() + 3600 * 1000;

  await Promise.all([
    invoke("kv_set", { key: KV_ACCESS_TOKEN, value: tokens.access_token }),
    invoke("kv_set", { key: KV_REFRESH_TOKEN, value: tokens.refresh_token }),
    invoke("kv_set", { key: KV_ACCOUNT_ID, value: accountId }),
    invoke("kv_set", { key: KV_EXPIRES_AT, value: String(expiresAt) }),
  ]);

  return { accountId, expiresAt };
}

export const useCodexAuthStore = create<CodexAuthState>()((set, get) => ({
  accessToken: null,
  refreshToken: null,
  accountId: null,
  expiresAt: null,
  status: "idle",
  userCode: null,
  verificationUrl: "https://auth.openai.com/codex/device",
  browserAuthUrl: null,
  error: null,

  initialize: async () => {
    try {
      const [accessToken, refreshToken, accountId, expiresAtStr] = await Promise.all([
        invoke<string | null>("kv_get", { key: KV_ACCESS_TOKEN }),
        invoke<string | null>("kv_get", { key: KV_REFRESH_TOKEN }),
        invoke<string | null>("kv_get", { key: KV_ACCOUNT_ID }),
        invoke<string | null>("kv_get", { key: KV_EXPIRES_AT }),
      ]);

      if (accessToken && refreshToken) {
        const expiresAt = expiresAtStr ? parseInt(expiresAtStr, 10) : null;
        set({
          accessToken,
          refreshToken,
          accountId,
          expiresAt,
          status: "authenticated",
        });
        logInfo("[codex-auth] Loaded stored credentials");
      }
    } catch (e) {
      logError(`[codex-auth] Failed to load stored credentials: ${formatError(e)}`);
    }
  },

  startLogin: async (method = "browser") => {
    // Cancel any existing poll
    pollAbortController?.abort();
    invoke("codex_oauth_cancel").catch(() => {});

    if (method === "browser") {
      set({ status: "opening_browser", error: null, userCode: null, browserAuthUrl: null });

      try {
        const port = await invoke<number>("codex_oauth_start");
        const browserAuth = await createBrowserAuthRequest(port);
        set({ status: "waiting_browser", browserAuthUrl: browserAuth.authUrl });

        logInfo("[codex-auth] Opening browser login");
        openUrl(browserAuth.authUrl).catch((openError) => {
          logError(`[codex-auth] Failed to open browser automatically: ${formatError(openError)}`);
        });

        const callback = await invoke<OAuthCallbackResult>("codex_oauth_await");
        if (callback.state !== browserAuth.state) {
          throw new Error("Codex login state mismatch. Please try again.");
        }

        const tokens = await exchangeCodeForTokens(
          callback.code,
          browserAuth.verifier,
          browserAuth.redirectUri,
        );

        const { accountId, expiresAt } = await persistTokens(tokens);

        set({
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          accountId,
          expiresAt,
          status: "authenticated",
          userCode: null,
          browserAuthUrl: null,
        });

        logInfo("[codex-auth] Browser authentication successful");
        return;
      } catch (e) {
        const msg = formatError(e);
        logError(`[codex-auth] Browser login failed: ${msg}`);
        set({ status: "error", error: msg, userCode: null, browserAuthUrl: null });
        invoke("codex_oauth_cancel").catch(() => {});
        return;
      }
    }

    set({ status: "awaiting_code", error: null, userCode: null, browserAuthUrl: null });

    try {
      const deviceAuth = await startDeviceAuth();
      set({ userCode: deviceAuth.user_code, status: "polling" });

      logInfo(`[codex-auth] Device code: ${deviceAuth.user_code}`);

      // Start polling
      const controller = new AbortController();
      pollAbortController = controller;
      const interval = Math.max(deviceAuth.interval, 5) * 1000;

      while (!controller.signal.aborted) {
        await new Promise((resolve) => setTimeout(resolve, interval));
        if (controller.signal.aborted) return;

        try {
          const pollResult = await pollDeviceAuth(
            deviceAuth.device_auth_id,
            deviceAuth.user_code,
            controller.signal,
          );

          // Exchange for tokens
          const tokens = await exchangeCodeForTokens(
            pollResult.authorization_code,
            pollResult.code_verifier,
          );

          const { accountId, expiresAt } = await persistTokens(tokens);

          set({
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token,
            accountId,
            expiresAt,
            status: "authenticated",
            userCode: null,
            browserAuthUrl: null,
          });

          logInfo("[codex-auth] Authentication successful");
          pollAbortController = null;
          return;
        } catch (e) {
          // "authorization_pending" is expected while waiting — keep polling
          const msg = formatError(e);
          if (msg.includes("authorization_pending") || msg.includes("slow_down") || msg.includes("403")) {
            continue;
          }
          throw e;
        }
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      const msg = formatError(e);
      logError(`[codex-auth] Login failed: ${msg}`);
      set({ status: "error", error: msg, userCode: null, browserAuthUrl: null });
    }
  },

  cancelLogin: () => {
    pollAbortController?.abort();
    pollAbortController = null;
    invoke("codex_oauth_cancel").catch(() => {});
    set({ status: "idle", userCode: null, browserAuthUrl: null, error: null });
  },

  logout: async () => {
    try {
      await Promise.all([
        invoke("kv_delete", { key: KV_ACCESS_TOKEN }),
        invoke("kv_delete", { key: KV_REFRESH_TOKEN }),
        invoke("kv_delete", { key: KV_ACCOUNT_ID }),
        invoke("kv_delete", { key: KV_EXPIRES_AT }),
      ]);
    } catch (e) {
      logError(`[codex-auth] Failed to clear stored credentials: ${formatError(e)}`);
    }

    set({
      accessToken: null,
      refreshToken: null,
      accountId: null,
      expiresAt: null,
      status: "idle",
      userCode: null,
      browserAuthUrl: null,
      error: null,
    });
  },

  getValidToken: async () => {
    const state = get();
    if (!state.accessToken || !state.refreshToken) {
      throw new ProviderError("Not authenticated with Codex. Please connect your ChatGPT account.", "codex", 401);
    }

    // Refresh if within 60s of expiry
    if (state.expiresAt && Date.now() > state.expiresAt - 60_000) {
      logInfo("[codex-auth] Token expired or expiring soon, refreshing...");
      try {
        const tokens = await refreshAccessToken(state.refreshToken);
        const { accountId, expiresAt } = await persistTokens(tokens, state.accountId);

        set({
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          accountId,
          expiresAt,
        });

        return { accessToken: tokens.access_token, accountId };
      } catch (e) {
        logError(`[codex-auth] Token refresh failed: ${formatError(e)}`);
        // Clear auth state on refresh failure
        set({ status: "error", error: "Session expired. Please reconnect." });
        throw new ProviderError("Codex token refresh failed. Please reconnect your ChatGPT account.", "codex", 401);
      }
    }

    return {
      accessToken: state.accessToken,
      accountId: state.accountId || "",
    };
  },
}));
