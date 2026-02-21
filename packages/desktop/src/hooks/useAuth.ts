import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AuthUser } from "@thechat/shared";
import { api } from "../lib/api";

const KV_TOKEN = "auth_session_token";
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

export function useAuth() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Validate session on mount
  useEffect(() => {
    (async () => {
      try {
        const token = await kvGet(KV_TOKEN);
        if (!token) {
          setLoading(false);
          return;
        }

        const { data, error } = await api.auth.me.get({
          headers: { authorization: `Bearer ${token}` },
        });

        if (data && !error && "user" in data) {
          setUser(data.user);
          setToken(token);
          await kvSet(KV_USER, JSON.stringify(data.user));
        } else {
          // Token invalid — try cached user as fallback
          const cached = await kvGet(KV_USER);
          if (cached) {
            try {
              setUser(JSON.parse(cached));
              setToken(token);
            } catch {
              await kvDelete(KV_TOKEN);
              await kvDelete(KV_USER);
            }
          } else {
            await kvDelete(KV_TOKEN);
          }
        }
      } catch {
        // Server unreachable — fall back to cached user
        const storedToken = await kvGet(KV_TOKEN);
        const cached = await kvGet(KV_USER);
        if (cached) {
          try {
            setUser(JSON.parse(cached));
            if (storedToken) setToken(storedToken);
          } catch {
            // Corrupt cache
          }
        }
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const { data, error } = await api.auth.login.post({ email, password });

    if (error) throw new Error((error as any).error || "Login failed");
    if (!data || !("token" in data)) throw new Error("Login failed");

    await kvSet(KV_TOKEN, data.token!);
    await kvSet(KV_USER, JSON.stringify(data.user!));
    setToken(data.token!);
    setUser(data.user!);
  }, []);

  const register = useCallback(
    async (
      name: string,
      email: string,
      password: string
    ): Promise<string | null> => {
      const { data, error } = await api.auth.register.post({
        name,
        email,
        password,
      });

      if (error) throw new Error((error as any).error || "Registration failed");
      if (!data) throw new Error("Registration failed");

      // If verification required, return message
      if ("message" in data) {
        return data.message as string;
      }

      // Auto-login
      if ("token" in data) {
        await kvSet(KV_TOKEN, data.token!);
        await kvSet(KV_USER, JSON.stringify(data.user!));
        setToken(data.token!);
        setUser(data.user!);
      }
      return null;
    },
    []
  );

  const logout = useCallback(async () => {
    try {
      const token = await kvGet(KV_TOKEN);
      if (token) {
        await api.auth.logout.post(undefined, {
          headers: { authorization: `Bearer ${token}` },
        });
      }
    } catch {
      // Ignore network errors on logout
    }
    await kvDelete(KV_TOKEN);
    await kvDelete(KV_USER);
    setToken(null);
    setUser(null);
  }, []);

  return { user, token, loading, login, register, logout };
}
