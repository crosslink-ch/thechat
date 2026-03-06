import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import {
  generatePKCE,
  buildAuthUrl,
  exchangeCode,
  refreshAnthropicToken,
} from "../core/anthropic-auth";
import type { PKCECodes } from "../core/anthropic-auth";
import { error as logError, info as logInfo, formatError } from "../log";

type AnthropicAuthStatus = "idle" | "awaiting_code" | "authenticated" | "error";

interface AnthropicAuthState {
  accessToken: string | null;
  refreshToken: string | null;
  expiresAt: number | null;
  status: AnthropicAuthStatus;
  authUrl: string | null;
  error: string | null;

  initialize: () => Promise<void>;
  startLogin: () => Promise<void>;
  submitCode: (code: string) => Promise<void>;
  cancelLogin: () => void;
  logout: () => Promise<void>;
  getValidToken: () => Promise<{ accessToken: string }>;
}

let pendingPKCE: PKCECodes | null = null;

const KV_ACCESS_TOKEN = "anthropic_access_token";
const KV_REFRESH_TOKEN = "anthropic_refresh_token";
const KV_EXPIRES_AT = "anthropic_expires_at";

export const useAnthropicAuthStore = create<AnthropicAuthState>()((set, get) => ({
  accessToken: null,
  refreshToken: null,
  expiresAt: null,
  status: "idle",
  authUrl: null,
  error: null,

  initialize: async () => {
    try {
      const [accessToken, refreshToken, expiresAtStr] = await Promise.all([
        invoke<string | null>("kv_get", { key: KV_ACCESS_TOKEN }),
        invoke<string | null>("kv_get", { key: KV_REFRESH_TOKEN }),
        invoke<string | null>("kv_get", { key: KV_EXPIRES_AT }),
      ]);

      if (accessToken && refreshToken) {
        const expiresAt = expiresAtStr ? parseInt(expiresAtStr, 10) : null;
        set({
          accessToken,
          refreshToken,
          expiresAt,
          status: "authenticated",
        });
        logInfo("[anthropic-auth] Loaded stored credentials");
      }
    } catch (e) {
      logError(`[anthropic-auth] Failed to load stored credentials: ${formatError(e)}`);
    }
  },

  startLogin: async () => {
    set({ status: "awaiting_code", error: null, authUrl: null });

    try {
      const pkce = await generatePKCE();
      pendingPKCE = pkce;
      const authUrl = buildAuthUrl(pkce);
      set({ authUrl });
      logInfo("[anthropic-auth] Authorization URL generated");
    } catch (e) {
      const msg = formatError(e);
      logError(`[anthropic-auth] Failed to start login: ${msg}`);
      set({ status: "error", error: msg });
    }
  },

  submitCode: async (code: string) => {
    if (!pendingPKCE) {
      set({ status: "error", error: "No pending authorization. Please start again." });
      return;
    }

    try {
      const tokens = await exchangeCode(code.trim(), pendingPKCE.verifier);
      const expiresAt = tokens.expires_in
        ? Date.now() + tokens.expires_in * 1000
        : Date.now() + 3600 * 1000;

      await Promise.all([
        invoke("kv_set", { key: KV_ACCESS_TOKEN, value: tokens.access_token }),
        invoke("kv_set", { key: KV_REFRESH_TOKEN, value: tokens.refresh_token }),
        invoke("kv_set", { key: KV_EXPIRES_AT, value: String(expiresAt) }),
      ]);

      set({
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt,
        status: "authenticated",
        authUrl: null,
      });

      pendingPKCE = null;
      logInfo("[anthropic-auth] Authentication successful");
    } catch (e) {
      const msg = formatError(e);
      logError(`[anthropic-auth] Code exchange failed: ${msg}`);
      set({ status: "error", error: msg });
    }
  },

  cancelLogin: () => {
    pendingPKCE = null;
    set({ status: "idle", authUrl: null, error: null });
  },

  logout: async () => {
    try {
      await Promise.all([
        invoke("kv_delete", { key: KV_ACCESS_TOKEN }),
        invoke("kv_delete", { key: KV_REFRESH_TOKEN }),
        invoke("kv_delete", { key: KV_EXPIRES_AT }),
      ]);
    } catch (e) {
      logError(`[anthropic-auth] Failed to clear stored credentials: ${formatError(e)}`);
    }

    pendingPKCE = null;
    set({
      accessToken: null,
      refreshToken: null,
      expiresAt: null,
      status: "idle",
      authUrl: null,
      error: null,
    });
  },

  getValidToken: async () => {
    const state = get();
    if (!state.accessToken || !state.refreshToken) {
      throw new Error("Not authenticated with Anthropic. Please connect your Claude account.");
    }

    // Refresh if within 60s of expiry
    if (state.expiresAt && Date.now() > state.expiresAt - 60_000) {
      logInfo("[anthropic-auth] Token expired or expiring soon, refreshing...");
      try {
        const tokens = await refreshAnthropicToken(state.refreshToken);
        const expiresAt = tokens.expires_in
          ? Date.now() + tokens.expires_in * 1000
          : Date.now() + 3600 * 1000;

        await Promise.all([
          invoke("kv_set", { key: KV_ACCESS_TOKEN, value: tokens.access_token }),
          invoke("kv_set", { key: KV_REFRESH_TOKEN, value: tokens.refresh_token }),
          invoke("kv_set", { key: KV_EXPIRES_AT, value: String(expiresAt) }),
        ]);

        set({
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          expiresAt,
        });

        return { accessToken: tokens.access_token };
      } catch (e) {
        logError(`[anthropic-auth] Token refresh failed: ${formatError(e)}`);
        set({ status: "error", error: "Session expired. Please reconnect." });
        throw new Error("Anthropic token refresh failed. Please reconnect your Claude account.");
      }
    }

    return { accessToken: state.accessToken };
  },
}));
