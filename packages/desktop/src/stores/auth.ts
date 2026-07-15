import { invoke } from "@tauri-apps/api/core";
import type { AuthUser } from "@thechat/shared";
import { create } from "zustand";
import { api } from "../lib/api";
import { edenErrorMessage, isAuthoritativeAuthRejection } from "../lib/eden";
import { queryClient } from "../lib/query-client";

const KV_ACCESS_TOKEN = "auth_access_token";
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

async function clearStoredAuth() {
  await Promise.all([kvDelete(KV_ACCESS_TOKEN), kvDelete(KV_USER)]);
}

async function persistCredentials(accessToken: string, user: AuthUser) {
  await Promise.all([
    kvSet(KV_ACCESS_TOKEN, accessToken),
    kvSet(KV_USER, JSON.stringify(user)),
  ]);
}

interface AuthStore {
  user: AuthUser | null;
  token: string | null;
  loading: boolean;
  initialize: () => Promise<void>;
  login: (email: string, password: string) => Promise<void>;
  register: (
    name: string,
    email: string,
    password: string,
  ) => Promise<string | null>;
  verifyEmailOtp: (email: string, code: string) => Promise<void>;
  logout: () => Promise<void>;
}

export const useAuthStore = create<AuthStore>()((set) => ({
  user: null,
  token: null,
  loading: true,

  initialize: async () => {
    const restoreCachedState = (
      accessToken: string | null,
      cachedUser: string | null,
    ) => {
      if (!accessToken || !cachedUser) return;
      try {
        set({ user: JSON.parse(cachedUser) as AuthUser, token: accessToken });
      } catch {
        // A corrupt cache is ignored without deleting a potentially valid
        // credential during an outage.
      }
    };

    let accessToken: string | null = null;
    let cachedUser: string | null = null;
    try {
      [accessToken, cachedUser] = await Promise.all([
        kvGet(KV_ACCESS_TOKEN),
        kvGet(KV_USER),
      ]);

      if (!accessToken) return;

      const me = await api.auth.me.get({
        headers: { authorization: `Bearer ${accessToken}` },
      });
      if (me.data && !me.error && "user" in me.data && me.data.user) {
        await persistCredentials(accessToken, me.data.user);
        set({ user: me.data.user, token: accessToken });
        return;
      }

      if (isAuthoritativeAuthRejection(me.error)) {
        await clearStoredAuth();
        return;
      }

      restoreCachedState(accessToken, cachedUser);
    } catch {
      // Preserve cached state on transport and authentication-service failures.
      restoreCachedState(accessToken, cachedUser);
    } finally {
      set({ loading: false });
    }
  },

  login: async (email: string, password: string) => {
    const { data, error } = await api.auth.login.post({ email, password });

    if (error) throw new Error(edenErrorMessage(error, "Login failed"));
    if (!data || !("accessToken" in data) || !("user" in data) || !data.user) {
      throw new Error("Login failed");
    }

    await persistCredentials(data.accessToken, data.user);
    set({ token: data.accessToken, user: data.user });
  },

  register: async (
    name: string,
    email: string,
    password: string,
  ): Promise<string | null> => {
    const { data, error } = await api.auth.register.post({
      name,
      email,
      password,
    });

    if (error) throw new Error(edenErrorMessage(error, "Registration failed"));
    if (!data) throw new Error("Registration failed");

    if ("message" in data) return data.message;

    if ("accessToken" in data && "user" in data && data.user) {
      await persistCredentials(data.accessToken, data.user);
      set({ token: data.accessToken, user: data.user });
    }
    return null;
  },

  verifyEmailOtp: async (email: string, code: string) => {
    const { data, error } = await api.auth["verify-email"].post({
      email,
      code,
    });

    if (error) throw new Error(edenErrorMessage(error, "Verification failed"));
    if (!data || !("accessToken" in data) || !("user" in data) || !data.user) {
      throw new Error("Verification failed");
    }

    await persistCredentials(data.accessToken, data.user);
    set({ token: data.accessToken, user: data.user });
  },

  logout: async () => {
    const accessToken = await kvGet(KV_ACCESS_TOKEN);
    if (accessToken) {
      const { error } = await api.auth.logout.post(
        {},
        { headers: { authorization: `Bearer ${accessToken}` } },
      );
      // A 401/403 means the credential is already unusable and local cleanup is
      // safe. For transport/5xx failures, retain the sole token so the user can
      // retry authoritative server-side revocation.
      if (error && !isAuthoritativeAuthRejection(error)) {
        throw new Error(edenErrorMessage(error, "Logout failed"));
      }
    }

    await clearStoredAuth();
    queryClient.clear();
    set({ token: null, user: null });
  },
}));
