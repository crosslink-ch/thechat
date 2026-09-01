import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../lib/api";
import { queryClient } from "../lib/query-client";
import { EmailVerificationRequiredError, useAuthStore } from "./auth";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../lib/api", () => ({
  api: {
    auth: {
      register: { post: vi.fn() },
      login: { post: vi.fn() },
      "verify-email": { post: vi.fn() },
      "request-password-reset": { post: vi.fn() },
      "reset-password": { post: vi.fn() },
      me: { get: vi.fn(), patch: vi.fn() },
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

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function useKv(
  initial: Record<string, string> = {},
  beforeSet?: (key: string, value: string) => Promise<void>,
) {
  const values = { ...initial };
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    const input = args as { key?: string; value?: string } | undefined;
    const key = input?.key ?? "";
    if (command === "kv_get") return values[key] ?? null;
    if (command === "kv_set" && input?.key && input.value !== undefined) {
      await beforeSet?.(input.key, input.value);
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

  it("surfaces the typed recovery state for an accepted unverified login", async () => {
    vi.mocked(api.auth.login.post).mockResolvedValue({
      data: null,
      error: treatyError(403, {
        error: "Please verify your email before logging in",
        verificationRequired: true,
      }),
    } as any);

    const attempt = useAuthStore
      .getState()
      .login("Jane@Example.com", "password123");
    await expect(attempt).rejects.toBeInstanceOf(
      EmailVerificationRequiredError,
    );
    await expect(attempt).rejects.toMatchObject({
      email: "jane@example.com",
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

  it("uses the public password reset request and confirmation endpoints", async () => {
    vi.mocked(api.auth["request-password-reset"].post).mockResolvedValue({
      data: {
        message:
          "If an account exists for that email, a password reset code will be sent.",
      },
      error: null,
    } as any);
    vi.mocked(api.auth["reset-password"].post).mockResolvedValue({
      data: {
        message: "Password reset. You can now log in with your new password.",
      },
      error: null,
    } as any);

    await expect(
      useAuthStore.getState().requestPasswordReset(user.email),
    ).resolves.toContain("If an account exists");
    expect(api.auth["request-password-reset"].post).toHaveBeenCalledWith({
      email: user.email,
    });

    await expect(
      useAuthStore
        .getState()
        .resetPassword(user.email, "123456", "new-password-456"),
    ).resolves.toContain("Password reset");
    expect(api.auth["reset-password"].post).toHaveBeenCalledWith({
      email: user.email,
      code: "123456",
      password: "new-password-456",
    });
    expect(useAuthStore.getState()).toMatchObject({ user: null, token: null });
  });

  it("surfaces sanitized password reset API failures", async () => {
    vi.mocked(api.auth["request-password-reset"].post).mockResolvedValue({
      data: null,
      error: treatyError(429, { error: "Too many requests" }),
    } as any);
    await expect(
      useAuthStore.getState().requestPasswordReset(user.email),
    ).rejects.toThrow("Too many requests");

    vi.mocked(api.auth["reset-password"].post).mockResolvedValue({
      data: null,
      error: treatyError(400, {
        error: "Invalid or expired password reset code",
      }),
    } as any);
    await expect(
      useAuthStore
        .getState()
        .resetPassword(user.email, "000000", "new-password-456"),
    ).rejects.toThrow("Invalid or expired password reset code");
  });
});

describe("auth store profile updates", () => {
  it("updates and persists the signed-in user returned by the API", async () => {
    const values = useKv({
      auth_access_token: "profile-session",
      auth_user: JSON.stringify(user),
    });
    const updatedUser = { ...user, name: "Jane Updated" };
    useAuthStore.setState({
      token: "profile-session",
      user,
      loading: false,
    });
    vi.mocked(api.auth.me.patch).mockResolvedValue({
      data: { user: updatedUser },
      error: null,
    } as any);

    await useAuthStore.getState().updateName("Jane Updated");

    expect(api.auth.me.patch).toHaveBeenCalledWith(
      { name: "Jane Updated" },
      { headers: { authorization: "Bearer profile-session" } },
    );
    expect(values).toEqual({
      auth_access_token: "profile-session",
      auth_user: JSON.stringify(updatedUser),
    });
    expect(useAuthStore.getState()).toMatchObject({
      token: "profile-session",
      user: updatedUser,
    });
  });

  it("sets and removes the signed-in user's profile picture", async () => {
    const values = useKv({
      auth_access_token: "profile-session",
      auth_user: JSON.stringify(user),
    });
    const avatar = "data:image/png;base64,cHJvZmlsZQ==";
    const picturedUser = { ...user, avatar };
    useAuthStore.setState({
      token: "profile-session",
      user,
      loading: false,
    });
    vi.mocked(api.auth.me.patch)
      .mockResolvedValueOnce({
        data: { user: picturedUser },
        error: null,
      } as any)
      .mockResolvedValueOnce({
        data: { user },
        error: null,
      } as any);

    await useAuthStore.getState().updateAvatar(avatar);
    expect(api.auth.me.patch).toHaveBeenNthCalledWith(
      1,
      { avatar },
      { headers: { authorization: "Bearer profile-session" } },
    );
    expect(values.auth_user).toBe(JSON.stringify(picturedUser));
    expect(useAuthStore.getState().user).toEqual(picturedUser);

    await useAuthStore.getState().updateAvatar(null);
    expect(api.auth.me.patch).toHaveBeenNthCalledWith(
      2,
      { avatar: null },
      { headers: { authorization: "Bearer profile-session" } },
    );
    expect(values.auth_user).toBe(JSON.stringify(user));
    expect(useAuthStore.getState().user).toEqual(user);
  });

  it.each([
    [400, "Name is required"],
    [503, "Authentication service temporarily unavailable"],
  ])(
    "keeps the current profile and cache after a retryable %s",
    async (status, message) => {
      const values = useKv({
        auth_access_token: "profile-session",
        auth_user: JSON.stringify(user),
      });
      useAuthStore.setState({
        token: "profile-session",
        user,
        loading: false,
      });
      vi.mocked(api.auth.me.patch).mockResolvedValue({
        data: null,
        error: treatyError(status, { error: message }),
      } as any);

      await expect(useAuthStore.getState().updateName("Jane Updated")).rejects
        .toThrow(message);

      expect(values).toEqual({
        auth_access_token: "profile-session",
        auth_user: JSON.stringify(user),
      });
      expect(queryClient.clear).not.toHaveBeenCalled();
      expect(useAuthStore.getState()).toMatchObject({
        token: "profile-session",
        user,
      });
    },
  );

  it("keeps the current profile and cache after a transport failure", async () => {
    const values = useKv({
      auth_access_token: "profile-session",
      auth_user: JSON.stringify(user),
    });
    useAuthStore.setState({
      token: "profile-session",
      user,
      loading: false,
    });
    vi.mocked(api.auth.me.patch).mockRejectedValue(new TypeError("fetch failed"));

    await expect(useAuthStore.getState().updateName("Jane Updated")).rejects
      .toThrow("fetch failed");

    expect(values).toEqual({
      auth_access_token: "profile-session",
      auth_user: JSON.stringify(user),
    });
    expect(queryClient.clear).not.toHaveBeenCalled();
    expect(useAuthStore.getState()).toMatchObject({
      token: "profile-session",
      user,
    });
  });

  it.each([401, 403])(
    "clears credentials after an authoritative profile-update %s",
    async (status) => {
      const values = useKv({
        auth_access_token: "profile-session",
        auth_user: JSON.stringify(user),
      });
      useAuthStore.setState({
        token: "profile-session",
        user,
        loading: false,
      });
      vi.mocked(api.auth.me.patch).mockResolvedValue({
        data: null,
        error: treatyError(status, { error: "Authentication required" }),
      } as any);

      await expect(useAuthStore.getState().updateName("Jane Updated")).rejects
        .toThrow("Authentication required");

      expect(values).toEqual({});
      expect(queryClient.clear).toHaveBeenCalledOnce();
      expect(useAuthStore.getState()).toMatchObject({
        token: null,
        user: null,
        loading: false,
      });
    },
  );

  it("serializes a profile save followed by logout", async () => {
    const writeStarted = deferred();
    const releaseWrite = deferred();
    let shouldBlock = true;
    const values = useKv(
      {
        auth_access_token: "profile-session",
        auth_user: JSON.stringify(user),
      },
      async (key) => {
        if (key === "auth_access_token" && shouldBlock) {
          shouldBlock = false;
          writeStarted.resolve();
          await releaseWrite.promise;
        }
      },
    );
    const updatedUser = { ...user, name: "Jane Updated" };
    useAuthStore.setState({
      token: "profile-session",
      user,
      loading: false,
    });
    vi.mocked(api.auth.me.patch).mockResolvedValue({
      data: { user: updatedUser },
      error: null,
    } as any);
    vi.mocked(api.auth.logout.post).mockResolvedValue({
      data: { success: true },
      error: null,
    } as any);

    const save = useAuthStore.getState().updateName("Jane Updated");
    await writeStarted.promise;
    const logout = useAuthStore.getState().logout();
    expect(api.auth.logout.post).not.toHaveBeenCalled();

    releaseWrite.resolve();
    await save;
    await logout;

    expect(values).toEqual({});
    expect(useAuthStore.getState()).toMatchObject({ token: null, user: null });
  });

  it("serializes a profile save followed by a different login", async () => {
    const writeStarted = deferred();
    const releaseWrite = deferred();
    let shouldBlock = true;
    const values = useKv(
      {
        auth_access_token: "profile-session",
        auth_user: JSON.stringify(user),
      },
      async (key) => {
        if (key === "auth_access_token" && shouldBlock) {
          shouldBlock = false;
          writeStarted.resolve();
          await releaseWrite.promise;
        }
      },
    );
    const updatedUser = { ...user, name: "Jane Updated" };
    const nextUser = {
      ...user,
      id: "user-2",
      name: "Alex",
      email: "alex@example.com",
    };
    useAuthStore.setState({
      token: "profile-session",
      user,
      loading: false,
    });
    vi.mocked(api.auth.me.patch).mockResolvedValue({
      data: { user: updatedUser },
      error: null,
    } as any);
    vi.mocked(api.auth.login.post).mockResolvedValue({
      data: { accessToken: "next-session", user: nextUser },
      error: null,
    } as any);

    const save = useAuthStore.getState().updateName("Jane Updated");
    await writeStarted.promise;
    const login = useAuthStore.getState().login(nextUser.email, "password123");
    expect(api.auth.login.post).not.toHaveBeenCalled();

    releaseWrite.resolve();
    await save;
    await login;

    expect(values).toEqual({
      auth_access_token: "next-session",
      auth_user: JSON.stringify(nextUser),
    });
    expect(useAuthStore.getState()).toMatchObject({
      token: "next-session",
      user: nextUser,
    });
  });

  it("requires a current bearer token", async () => {
    useAuthStore.setState({ token: null, user: null, loading: false });

    await expect(useAuthStore.getState().updateName("Jane")).rejects.toThrow(
      "Authentication required",
    );
    expect(api.auth.me.patch).not.toHaveBeenCalled();
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
      auth_refresh_token: "legacy-refresh-jwt",
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
