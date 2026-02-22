import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { AuthUser } from "@thechat/shared";
import { api } from "../lib/api";

const KV_ACCESS_TOKEN = "auth_access_token";
const KV_REFRESH_TOKEN = "auth_refresh_token";
const KV_USER = "auth_user";

async function kvGet(key: string): Promise<string | null> {
  return invoke<string | null>("kv_get", { key });
}

async function kvSet(key: string, value: string): Promise<void> {
  return invoke("kv_set", { key, value });
}

async function kvDelete(key: string): Promise<void> {
  return invoke("kv_delete", { key });
}

/** Decode JWT payload without verification (for reading exp claim client-side) */
function decodeJwtPayload(jwt: string): { exp?: number } | null {
  try {
    const parts = jwt.split(".");
    if (parts.length !== 3) return null;
    const payload = JSON.parse(atob(parts[1]));
    return payload;
  } catch {
    return null;
  }
}

interface AuthStore {
  user: AuthUser | null;
  token: string | null;
  loading: boolean;
  initialize: () => Promise<void>;
  login: (email: string, password: string) => Promise<void>;
  register: (name: string, email: string, password: string) => Promise<string | null>;
  logout: () => Promise<void>;
}

let refreshTimer: ReturnType<typeof setTimeout> | null = null;

function clearRefreshTimer() {
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
}

function scheduleRefresh(accessToken: string) {
  clearRefreshTimer();
  const payload = decodeJwtPayload(accessToken);
  if (!payload?.exp) return;

  // Refresh 60s before expiry
  const msUntilRefresh = payload.exp * 1000 - Date.now() - 60_000;
  if (msUntilRefresh <= 0) {
    doRefresh();
    return;
  }

  refreshTimer = setTimeout(doRefresh, msUntilRefresh);
}

async function doRefresh() {
  try {
    const refreshToken = await kvGet(KV_REFRESH_TOKEN);
    if (!refreshToken) return;

    const { data, error } = await api.auth.refresh.post({ refreshToken });

    if (data && !error && "accessToken" in data) {
      const newAccessToken = data.accessToken as string;
      await kvSet(KV_ACCESS_TOKEN, newAccessToken);
      useAuthStore.setState({ token: newAccessToken });
      scheduleRefresh(newAccessToken);
    }
  } catch {
    // Refresh failed
  }
}

export const useAuthStore = create<AuthStore>()((set) => ({
  user: null,
  token: null,
  loading: true,

  initialize: async () => {
    try {
      let accessToken = await kvGet(KV_ACCESS_TOKEN);
      const refreshToken = await kvGet(KV_REFRESH_TOKEN);

      if (!accessToken && !refreshToken) {
        set({ loading: false });
        return;
      }

      // Try using the access token
      if (accessToken) {
        const { data, error } = await api.auth.me.get({
          headers: { authorization: `Bearer ${accessToken}` },
        });

        if (data && !error && "user" in data) {
          set({ user: data.user, token: accessToken });
          await kvSet(KV_USER, JSON.stringify(data.user));
          scheduleRefresh(accessToken);
          return;
        }
      }

      // Access token invalid/expired - try refresh
      if (refreshToken) {
        const { data, error } = await api.auth.refresh.post({ refreshToken });
        if (data && !error && "accessToken" in data) {
          const newAccessToken = data.accessToken as string;
          await kvSet(KV_ACCESS_TOKEN, newAccessToken);
          set({ token: newAccessToken });
          scheduleRefresh(newAccessToken);

          // Fetch user info with new token
          const meRes = await api.auth.me.get({
            headers: { authorization: `Bearer ${newAccessToken}` },
          });
          if (meRes.data && !meRes.error && "user" in meRes.data) {
            set({ user: meRes.data.user });
            await kvSet(KV_USER, JSON.stringify(meRes.data.user));
            return;
          }
        }
      }

      // Both failed (server reachable but tokens invalid) - clear everything
      await kvDelete(KV_ACCESS_TOKEN);
      await kvDelete(KV_REFRESH_TOKEN);
      await kvDelete(KV_USER);
    } catch {
      // Server unreachable - fall back to cached user
      const storedToken = await kvGet(KV_ACCESS_TOKEN);
      const cached = await kvGet(KV_USER);
      if (cached) {
        try {
          const user = JSON.parse(cached);
          set({ user, token: storedToken });
        } catch {
          // Corrupt cache
        }
      }
    } finally {
      set({ loading: false });
    }
  },

  login: async (email: string, password: string) => {
    const { data, error } = await api.auth.login.post({ email, password });

    if (error) throw new Error((error as any).error || "Login failed");
    if (!data || !("accessToken" in data)) throw new Error("Login failed");

    await kvSet(KV_ACCESS_TOKEN, data.accessToken!);
    await kvSet(KV_REFRESH_TOKEN, data.refreshToken!);
    await kvSet(KV_USER, JSON.stringify(data.user!));
    set({ token: data.accessToken!, user: data.user! });
    scheduleRefresh(data.accessToken!);
  },

  register: async (name: string, email: string, password: string): Promise<string | null> => {
    const { data, error } = await api.auth.register.post({ name, email, password });

    if (error) throw new Error((error as any).error || "Registration failed");
    if (!data) throw new Error("Registration failed");

    // If verification required, return message
    if ("message" in data) {
      return data.message as string;
    }

    // Auto-login
    if ("accessToken" in data) {
      await kvSet(KV_ACCESS_TOKEN, data.accessToken!);
      await kvSet(KV_REFRESH_TOKEN, data.refreshToken!);
      await kvSet(KV_USER, JSON.stringify(data.user!));
      set({ token: data.accessToken!, user: data.user! });
      scheduleRefresh(data.accessToken!);
    }
    return null;
  },

  logout: async () => {
    clearRefreshTimer();
    try {
      const accessToken = await kvGet(KV_ACCESS_TOKEN);
      const refreshToken = await kvGet(KV_REFRESH_TOKEN);
      if (accessToken) {
        await api.auth.logout.post(
          { refreshToken: refreshToken ?? "" },
          { headers: { authorization: `Bearer ${accessToken}` } },
        );
      }
    } catch {
      // Ignore network errors on logout
    }
    await kvDelete(KV_ACCESS_TOKEN);
    await kvDelete(KV_REFRESH_TOKEN);
    await kvDelete(KV_USER);
    set({ token: null, user: null });
  },
}));
