import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../lib/api";
import { queryClient } from "../lib/query-client";
import { useAuthStore } from "./auth";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../lib/api", () => ({
  api: {
    auth: {
      register: { post: vi.fn() },
      login: { post: vi.fn() },
      "verify-email": { post: vi.fn() },
      me: { get: vi.fn() },
      logout: { post: vi.fn() },
    },
  },
}));
vi.mock("../lib/query-client", () => ({ queryClient: { clear: vi.fn() } }));

const user = {
  id: "user-1",
  name: "Jane",
  email: "jane@example.com",
  avatar: null,
  type: "human",
} as const;

function treatyError(status: number, value: unknown) {
  const error = new Error(String(value)) as Error & {
    status: number;
    value: unknown;
  };
  error.status = status;
  error.value = value;
  return error;
}

function useKv(initial: Record<string, string> = {}) {
  const values = { ...initial };
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    const input = args as { key?: string; value?: string } | undefined;
    const key = input?.key ?? "";
    if (command === "kv_get") return values[key] ?? null;
    if (command === "kv_set" && input?.key && input.value !== undefined) {
      values[input.key] = input.value;
    }
    if (command === "kv_delete" && input?.key) delete values[input.key];
    return null;
  });
  return values;
}

beforeEach(() => {
  vi.clearAllMocks();
  useAuthStore.setState({ user: null, token: null, loading: true });
  useKv();
});

describe("auth store account operations", () => {
  it("surfaces account and transport errors", async () => {
    vi.mocked(api.auth.register.post).mockResolvedValue({
      data: null,
      error: treatyError(409, {
        error: "An account with this email already exists",
      }),
    } as any);
    await expect(
      useAuthStore
        .getState()
        .register("Jane", "jane@example.com", "password123"),
    ).rejects.toThrow("An account with this email already exists");

    vi.mocked(api.auth.login.post).mockResolvedValue({
      data: null,
      error: treatyError(503, new TypeError("fetch failed")),
    } as any);
    await expect(
      useAuthStore.getState().login("jane@example.com", "password123"),
    ).rejects.toThrow(
      "Could not reach the server. Check your connection and try again.",
    );
  });

  it("persists only the opaque access token and user on login", async () => {
    const values = useKv();
    vi.mocked(api.auth.login.post).mockResolvedValue({
      data: { accessToken: "opaque-session-token", user },
      error: null,
    } as any);

    await useAuthStore.getState().login(user.email, "password123");

    expect(values).toEqual({
      auth_access_token: "opaque-session-token",
      auth_user: JSON.stringify(user),
    });
    expect(useAuthStore.getState()).toMatchObject({
      token: "opaque-session-token",
      user,
    });
  });

  it("persists the same one-token contract after registration", async () => {
    const values = useKv();
    vi.mocked(api.auth.register.post).mockResolvedValue({
      data: { accessToken: "registered-session", user },
      error: null,
    } as any);

    expect(
      await useAuthStore.getState().register("Jane", user.email, "password123"),
    ).toBeNull();
    expect(values).toEqual({
      auth_access_token: "registered-session",
      auth_user: JSON.stringify(user),
    });
  });

  it("uses /verify-email and persists its bearer session", async () => {
    const values = useKv();
    vi.mocked(api.auth["verify-email"].post).mockResolvedValue({
      data: { accessToken: "verified-session", user },
      error: null,
    } as any);

    await useAuthStore.getState().verifyEmailOtp(user.email, "123456");

    expect(api.auth["verify-email"].post).toHaveBeenCalledWith({
      email: user.email,
      code: "123456",
    });
    expect(values.auth_access_token).toBe("verified-session");
    expect(values.auth_user).toBe(JSON.stringify(user));
  });
});

describe("auth store initialization", () => {
  it("validates the one stored token with /me and refreshes the user cache", async () => {
    const values = useKv({
      auth_access_token: "opaque-session-token",
      auth_user: JSON.stringify({ ...user, name: "Stale Name" }),
    });
    vi.mocked(api.auth.me.get).mockResolvedValue({
      data: { user },
      error: null,
    } as any);

    await useAuthStore.getState().initialize();

    expect(api.auth.me.get).toHaveBeenCalledWith({
      headers: { authorization: "Bearer opaque-session-token" },
    });
    expect(values.auth_user).toBe(JSON.stringify(user));
    expect(useAuthStore.getState()).toMatchObject({
      token: "opaque-session-token",
      user,
      loading: false,
    });
  });

  it.each([401, 403])(
    "clears credentials after an authoritative %s",
    async (status) => {
      const values = useKv({
        auth_access_token: "rejected-session",
        auth_user: JSON.stringify(user),
      });
      vi.mocked(api.auth.me.get).mockResolvedValue({
        data: null,
        error: treatyError(status, { error: "Authentication required" }),
      } as any);

      await useAuthStore.getState().initialize();

      expect(values).toEqual({});
      expect(useAuthStore.getState()).toMatchObject({
        token: null,
        user: null,
        loading: false,
      });
    },
  );

  it("preserves cached state on a returned 503", async () => {
    const values = useKv({
      auth_access_token: "still-valid-session",
      auth_user: JSON.stringify(user),
    });
    vi.mocked(api.auth.me.get).mockResolvedValue({
      data: null,
      error: treatyError(503, { error: "Authentication service unavailable" }),
    } as any);

    await useAuthStore.getState().initialize();

    expect(values).toEqual({
      auth_access_token: "still-valid-session",
      auth_user: JSON.stringify(user),
    });
    expect(useAuthStore.getState()).toMatchObject({
      token: "still-valid-session",
      user,
      loading: false,
    });
  });

  it("preserves cached state on a thrown transport failure", async () => {
    useKv({
      auth_access_token: "offline-session",
      auth_user: JSON.stringify(user),
    });
    vi.mocked(api.auth.me.get).mockRejectedValue(new TypeError("fetch failed"));

    await useAuthStore.getState().initialize();

    expect(useAuthStore.getState()).toMatchObject({
      token: "offline-session",
      user,
      loading: false,
    });
  });
});

describe("auth store logout", () => {
  it("sends the bearer token, then clears the token and cached user", async () => {
    const values = useKv({
      auth_access_token: "logout-session",
      auth_user: JSON.stringify(user),
    });
    useAuthStore.setState({ token: "logout-session", user, loading: false });
    vi.mocked(api.auth.logout.post).mockResolvedValue({
      data: { success: true },
      error: null,
    } as any);

    await useAuthStore.getState().logout();

    expect(api.auth.logout.post).toHaveBeenCalledWith(
      {},
      { headers: { authorization: "Bearer logout-session" } },
    );
    expect(values).toEqual({});
    expect(queryClient.clear).toHaveBeenCalledOnce();
    expect(useAuthStore.getState()).toMatchObject({ token: null, user: null });
  });

  it("retains the sole credential when server revocation is retryable", async () => {
    const values = useKv({
      auth_access_token: "retry-session",
      auth_user: JSON.stringify(user),
    });
    useAuthStore.setState({ token: "retry-session", user, loading: false });
    vi.mocked(api.auth.logout.post).mockResolvedValue({
      data: null,
      error: treatyError(503, {
        error: "Authentication service temporarily unavailable",
      }),
    } as any);

    await expect(useAuthStore.getState().logout()).rejects.toThrow(
      "Authentication service temporarily unavailable",
    );

    expect(values).toEqual({
      auth_access_token: "retry-session",
      auth_user: JSON.stringify(user),
    });
    expect(queryClient.clear).not.toHaveBeenCalled();
    expect(useAuthStore.getState()).toMatchObject({
      token: "retry-session",
      user,
    });
  });

  it("retains the sole credential on transport failure", async () => {
    const values = useKv({
      auth_access_token: "offline-session",
      auth_user: JSON.stringify(user),
    });
    useAuthStore.setState({ token: "offline-session", user, loading: false });
    vi.mocked(api.auth.logout.post).mockRejectedValue(new TypeError("fetch failed"));

    await expect(useAuthStore.getState().logout()).rejects.toThrow("fetch failed");

    expect(values).toEqual({
      auth_access_token: "offline-session",
      auth_user: JSON.stringify(user),
    });
    expect(queryClient.clear).not.toHaveBeenCalled();
    expect(useAuthStore.getState()).toMatchObject({
      token: "offline-session",
      user,
    });
  });

  it("clears local credentials when the server says the token is already invalid", async () => {
    const values = useKv({
      auth_access_token: "invalid-session",
      auth_user: JSON.stringify(user),
    });
    useAuthStore.setState({ token: "invalid-session", user, loading: false });
    vi.mocked(api.auth.logout.post).mockResolvedValue({
      data: null,
      error: treatyError(401, { error: "Authentication required" }),
    } as any);

    await useAuthStore.getState().logout();

    expect(values).toEqual({});
    expect(queryClient.clear).toHaveBeenCalledOnce();
    expect(useAuthStore.getState()).toMatchObject({ token: null, user: null });
  });
});
