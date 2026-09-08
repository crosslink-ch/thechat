import { services } from "#platform-services";
import type { CredentialKey } from "../platform/contracts";
const announceSessionChange = () => services.announceSessionChange();
import { onSessionExpired, resetPrivateSession, sessionGeneration } from "../lib/session-boundary";
import { isWeb } from "../platform/environment";
import type { AuthUser } from "@thechat/shared";
import { create } from "zustand";
import { api } from "../lib/api";
import {
  authHeaders,
  edenErrorMessage,
  edenErrorStatus,
  isAuthoritativeAuthRejection,
} from "../lib/eden";
import { queryClient } from "../lib/query-client";

const KV_ACCESS_TOKEN = "auth_access_token";
const KV_USER = "auth_user";
const LEGACY_KV_REFRESH_TOKEN = "auth_refresh_token";

export class EmailVerificationRequiredError extends Error {
  readonly email: string;

  constructor(email: string) {
    super("Please verify your email before logging in");
    this.name = "EmailVerificationRequiredError";
    this.email = email;
  }
}

function requiresEmailVerification(error: unknown) {
  if (edenErrorStatus(error) !== 403 || !error || typeof error !== "object") {
    return false;
  }
  const value = "value" in error ? (error as { value?: unknown }).value : error;
  return Boolean(
    value &&
      typeof value === "object" &&
      "verificationRequired" in value &&
      (value as { verificationRequired?: unknown }).verificationRequired === true,
  );
}

async function kvGet(key: CredentialKey): Promise<string | null> {
  return services.credentials!.get(key);
}

async function kvSet(key: CredentialKey, value: string): Promise<void> {
  return services.credentials!.set(key, value);
}

async function kvDelete(key: CredentialKey): Promise<void> {
  return services.credentials!.delete(key);
}

async function clearStoredAuth() {
  if (isWeb) return;
  await Promise.all([
    kvDelete(KV_ACCESS_TOKEN),
    kvDelete(KV_USER),
    kvDelete(LEGACY_KV_REFRESH_TOKEN),
  ]);
}

async function persistCredentials(accessToken: string | null, user: AuthUser) {
  if (isWeb || !accessToken) return;
  await Promise.all([
    kvSet(KV_ACCESS_TOKEN, accessToken),
    kvSet(KV_USER, JSON.stringify(user)),
  ]);
}

function returnedSessionToken(data: unknown): string | null {
  if (isWeb) return null;
  if (!data || typeof data !== "object" || !("accessToken" in data) ||
      typeof data.accessToken !== "string" || !data.accessToken) {
    throw new Error("Invalid session response");
  }
  return data.accessToken;
}

let authMutationQueue: Promise<void> = Promise.resolve();

function runAuthMutation<T>(mutation: () => Promise<T>): Promise<T> {
  const run = () => isWeb && navigator.locks?.request
    ? navigator.locks.request("thechat:auth-mutation", mutation)
    : mutation();
  const result = authMutationQueue.then(run, run);
  authMutationQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
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
  requestPasswordReset: (email: string) => Promise<string>;
  resetPassword: (
    email: string,
    code: string,
    password: string,
  ) => Promise<string>;
  updateName: (name: string) => Promise<void>;
  logout: () => Promise<void>;
}

export const useAuthStore = create<AuthStore>()((set, get) => ({
  user: null,
  token: null,
  loading: true,

  initialize: () => runAuthMutation(async () => {
    if (isWeb) {
      const generation = sessionGeneration();
      try {
        const me = await api.auth.me.get(authHeaders(null));
        if (generation !== sessionGeneration()) return;
        const user = !me.error && me.data && "user" in me.data ? me.data.user : null;
        if (user) {
          if (get().user?.id !== user.id) resetPrivateSession();
          set({ user, token: null });
        } else if (edenErrorStatus(me.error) === 401) {
          resetPrivateSession();
          set({ user: null, token: null });
        }
      } catch {
        // A hidden-tab network failure is not proof of logout. Preserve only
        // this tab's existing in-memory identity/drafts, never an offline cache.
      } finally {
        set({ loading: false });
      }
      return;
    }
    // The custom refresh JWT was removed with Better Auth. Purge it even when
    // the current session cannot be validated because of a network outage.
    try {
      await kvDelete(LEGACY_KV_REFRESH_TOKEN);
    } catch {
      // A KV failure must not prevent restoring the current Better Auth token.
    }
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
  }),

  login: (email: string, password: string) => runAuthMutation(async () => {
    const { data, error } = await api.auth.login.post({ email, password });

    if (error) {
      if (requiresEmailVerification(error)) {
        throw new EmailVerificationRequiredError(email.trim().toLowerCase());
      }
      throw new Error(edenErrorMessage(error, "Login failed"));
    }
    if (!data || (!isWeb && !("accessToken" in data)) || !("user" in data) || !data.user) {
      throw new Error("Login failed");
    }

    const token = returnedSessionToken(data);
    await persistCredentials(token, data.user);
    if (isWeb) resetPrivateSession();
    set({ token, user: data.user });
    announceSessionChange();
  }),

  register: (
    name: string,
    email: string,
    password: string,
  ): Promise<string | null> => runAuthMutation(async () => {
    const { data, error } = await api.auth.register.post({
      name,
      email,
      password,
    });

    if (error) throw new Error(edenErrorMessage(error, "Registration failed"));
    if (!data) throw new Error("Registration failed");

    if ("message" in data) return data.message;

    if ((isWeb || "accessToken" in data) && "user" in data && data.user) {
      const token = returnedSessionToken(data);
      await persistCredentials(token, data.user);
      if (isWeb) resetPrivateSession();
      set({ token, user: data.user });
      announceSessionChange();
    }
    return null;
  }),

  verifyEmailOtp: (email: string, code: string) => runAuthMutation(async () => {
    const { data, error } = await api.auth["verify-email"].post({
      email,
      code,
    });

    if (error) throw new Error(edenErrorMessage(error, "Verification failed"));
    if (!data || (!isWeb && !("accessToken" in data)) || !("user" in data) || !data.user) {
      throw new Error("Verification failed");
    }

    const token = returnedSessionToken(data);
    await persistCredentials(token, data.user);
    if (isWeb) resetPrivateSession();
    set({ token, user: data.user });
    announceSessionChange();
  }),

  requestPasswordReset: (email: string) => runAuthMutation(async () => {
    const { data, error } = await api.auth["request-password-reset"].post({
      email,
    });
    if (error) {
      throw new Error(
        edenErrorMessage(error, "Could not request a password reset"),
      );
    }
    if (
      !data ||
      !("message" in data) ||
      typeof data.message !== "string"
    ) {
      throw new Error("Could not request a password reset");
    }
    return data.message;
  }),

  resetPassword: (email: string, code: string, password: string) =>
    runAuthMutation(async () => {
      const { data, error } = await api.auth["reset-password"].post({
        email,
        code,
        password,
      });
      if (error) {
        throw new Error(edenErrorMessage(error, "Could not reset password"));
      }
      if (
        !data ||
        !("message" in data) ||
        typeof data.message !== "string"
      ) {
        throw new Error("Could not reset password");
      }
      return data.message;
    }),

  updateName: (name: string) => runAuthMutation(async () => {
    const generation = sessionGeneration();
    const accessToken = get().token;
    if (isWeb ? !get().user : !accessToken) throw new Error("Authentication required");

    const { data, error } = await api.auth.me.patch(
      { name },
      authHeaders(accessToken),
    );

    if (error) {
      if (
        isAuthoritativeAuthRejection(error) &&
        (isWeb ? generation === sessionGeneration() : get().token === accessToken)
      ) {
        await clearStoredAuth();
        if (isWeb) resetPrivateSession();
        else queryClient.clear();
        set({ token: null, user: null, loading: false });
      }
      throw new Error(edenErrorMessage(error, "Could not update profile"));
    }
    if (!data || !("user" in data) || !data.user) {
      throw new Error("Could not update profile");
    }
    if (isWeb ? generation !== sessionGeneration() : get().token !== accessToken) {
      throw new Error("Authentication state changed while updating profile");
    }

    await persistCredentials(accessToken, data.user);
    set({ user: data.user });
  }),

  logout: () => runAuthMutation(async () => {
    const accessToken = isWeb ? null : await kvGet(KV_ACCESS_TOKEN);
    if (isWeb || accessToken) {
      const { error } = await api.auth.logout.post(
        {},
        authHeaders(accessToken),
      );
      // A 401/403 means the credential is already unusable and local cleanup is
      // safe. For transport/5xx failures, retain the sole token so the user can
      // retry authoritative server-side revocation.
      if (error && !isAuthoritativeAuthRejection(error)) {
        throw new Error(edenErrorMessage(error, "Logout failed"));
      }
    }

    await clearStoredAuth();
    if (isWeb) resetPrivateSession();
    else queryClient.clear();
    set({ token: null, user: null });
    announceSessionChange();
  }),
}));

onSessionExpired(() => {
  if (isWeb) useAuthStore.setState({ user: null, token: null, loading: false });
});
