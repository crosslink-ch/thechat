import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AuthUser } from "@thechat/shared";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:3000";

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

        const res = await fetch(`${API_URL}/auth/me`, {
          headers: { Authorization: `Bearer ${token}` },
        });

        if (res.ok) {
          const data = await res.json();
          setUser(data.user);
          await kvSet(KV_USER, JSON.stringify(data.user));
        } else {
          // Token invalid — try cached user as fallback
          const cached = await kvGet(KV_USER);
          if (cached) {
            try {
              setUser(JSON.parse(cached));
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
        const cached = await kvGet(KV_USER);
        if (cached) {
          try {
            setUser(JSON.parse(cached));
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
    const res = await fetch(`${API_URL}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Login failed");

    await kvSet(KV_TOKEN, data.token);
    await kvSet(KV_USER, JSON.stringify(data.user));
    setUser(data.user);
  }, []);

  const register = useCallback(
    async (
      name: string,
      email: string,
      password: string
    ): Promise<string | null> => {
      const res = await fetch(`${API_URL}/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, password }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Registration failed");

      // If verification required, return message
      if (data.message) {
        return data.message;
      }

      // Auto-login
      await kvSet(KV_TOKEN, data.token);
      await kvSet(KV_USER, JSON.stringify(data.user));
      setUser(data.user);
      return null;
    },
    []
  );

  const logout = useCallback(async () => {
    try {
      const token = await kvGet(KV_TOKEN);
      if (token) {
        await fetch(`${API_URL}/auth/logout`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
        });
      }
    } catch {
      // Ignore network errors on logout
    }
    await kvDelete(KV_TOKEN);
    await kvDelete(KV_USER);
    setUser(null);
  }, []);

  return { user, loading, login, register, logout };
}
