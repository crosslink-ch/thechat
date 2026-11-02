import { beforeEach, expect, it, vi } from "vitest";
import type { NotificationPreferences } from "@thechat/shared";

const { preferencesGet, preferencesPatch } = vi.hoisted(() => ({
  preferencesGet: vi.fn(),
  preferencesPatch: vi.fn(),
}));
vi.mock("../lib/api", () => ({
  api: { push: { preferences: { get: preferencesGet, patch: preferencesPatch } } },
}));
import { useAuthStore } from "./auth";
import {
  agentProgressNotificationsEnabled,
  useNotificationPreferencesStore,
} from "./notification-preferences";
import { resetPrivateSession } from "../lib/session-boundary";

const user = { id: "alice", name: "Alice", email: "alice@example.invalid", avatar: null, type: "human" } as const;
const defaults: NotificationPreferences = {
  directMessages: true,
  mentions: true,
  agentReplies: true,
  agentRequests: true,
  agentProgress: false,
  showPreviews: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  useAuthStore.setState({ token: "token-alice", user, loading: false });
  useNotificationPreferencesStore.getState().reset();
  preferencesGet.mockResolvedValue({ data: defaults, error: null });
});

it("stays quiet about progress until the person opts in", async () => {
  expect(agentProgressNotificationsEnabled()).toBe(false);
  await useNotificationPreferencesStore.getState().ensureLoaded();
  expect(agentProgressNotificationsEnabled()).toBe(false);

  preferencesPatch.mockResolvedValueOnce({ data: { ...defaults, agentProgress: true }, error: null });
  await useNotificationPreferencesStore.getState().update({ agentProgress: true });
  expect(agentProgressNotificationsEnabled()).toBe(true);
});

it.each(["saved", "refused"] as const)(
  "a save that is %s after sign-out never lands in the next account",
  async (outcome) => {
    await useNotificationPreferencesStore.getState().ensureLoaded();
    let finish!: (value: unknown) => void;
    preferencesPatch.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const pending = useNotificationPreferencesStore.getState().update({ agentProgress: true });

    resetPrivateSession();
    useAuthStore.setState({ token: "token-bob", user: { ...user, id: "bob" } });
    finish(
      outcome === "saved"
        ? { data: { ...defaults, agentProgress: true }, error: null }
        : { data: null, error: { status: 500 } },
    );
    await pending.catch(() => undefined);

    expect(useNotificationPreferencesStore.getState().preferences).toBeNull();
  },
);
