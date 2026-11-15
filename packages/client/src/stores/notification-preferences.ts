import { create } from "zustand";
import type { NotificationPreferences } from "@thechat/shared";
import { api } from "../lib/api";
import { authHeaders } from "../lib/eden";
import { isAuthenticated } from "../lib/auth-identity";
import { onSessionReset, sessionGeneration } from "../lib/session-boundary";
import { useAuthStore } from "./auth";

/**
 * Account-wide notification choices, stored on the server so background push
 * and in-app notifications follow the same rules on every device.
 */
interface NotificationPreferencesState {
  preferences: NotificationPreferences | null;
  /** Load once per session; later calls reuse the cached choices. */
  ensureLoaded: () => Promise<NotificationPreferences | null>;
  /** Save one choice optimistically; reverts and throws if the server refuses. */
  update: (changes: Partial<NotificationPreferences>) => Promise<NotificationPreferences>;
  reset: () => void;
}

let inFlight: Promise<NotificationPreferences | null> | null = null;

function asPreferences(value: unknown): NotificationPreferences | null {
  if (!value || typeof value !== "object" || "error" in value) return null;
  return value as NotificationPreferences;
}

export const useNotificationPreferencesStore = create<NotificationPreferencesState>()(
  (set, get) => ({
    preferences: null,

    ensureLoaded: async () => {
      const cached = get().preferences;
      if (cached) return cached;
      if (inFlight) return inFlight;
      const token = useAuthStore.getState().token;
      // On web a 401 expires the browser session; never probe while signed out.
      if (!isAuthenticated(token)) return null;
      const generation = sessionGeneration();
      inFlight = (async () => {
        try {
          const { data, error } = await api.push.preferences.get(authHeaders(token));
          const loaded = error ? null : asPreferences(data);
          // A load that lands after sign-out must not leak into the next session.
          if (loaded && generation === sessionGeneration()) set({ preferences: loaded });
          return loaded;
        } catch {
          return null;
        } finally {
          inFlight = null;
        }
      })();
      return inFlight;
    },

    update: async (changes) => {
      const previous = get().preferences;
      if (previous) set({ preferences: { ...previous, ...changes } });
      const token = useAuthStore.getState().token;
      const generation = sessionGeneration();
      // A save (or its revert) that lands after sign-out must not leak into the next session.
      const current = () => generation === sessionGeneration();
      try {
        const { data, error } = await api.push.preferences.patch(changes, authHeaders(token));
        const saved = error ? null : asPreferences(data);
        if (!saved) throw new Error("Couldn't save notification choices");
        if (current()) set({ preferences: saved });
        return saved;
      } catch (error) {
        if (current()) set({ preferences: previous });
        throw error;
      }
    },

    reset: () => {
      inFlight = null;
      set({ preferences: null });
    },
  }),
);

onSessionReset(() => useNotificationPreferencesStore.getState().reset());

/** Whether a channel message that mentions you should notify in-app. */
export function mentionNotificationsEnabled() {
  // Before the choices load, follow the server default (on).
  return useNotificationPreferencesStore.getState().preferences?.mentions !== false;
}

/** Whether a reply in a followed thread should notify in-app. */
export function threadReplyNotificationsEnabled() {
  // Older servers omit the choice; it is on by default.
  return useNotificationPreferencesStore.getState().preferences?.threadReplies !== false;
}

/**
 * Whether an agent's progress update should notify. Until the choices load,
 * stay quiet: "Final results only" is the default.
 */
export function agentProgressNotificationsEnabled() {
  const preferences = useNotificationPreferencesStore.getState().preferences;
  return Boolean(preferences?.agentReplies && preferences.agentProgress);
}
