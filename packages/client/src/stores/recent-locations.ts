import { create } from "zustand";
import { preferences } from "../platform/preferences";

const KV_KEY = "recent_locations";
const MAX_RECENT = 30;

interface StoredRecents {
  userId: string;
  keys: string[];
}

export interface CurrentLocation {
  conversationId: string;
  type: "direct" | "group";
  threadId: string | null;
}

interface RecentLocationsStore {
  userId: string | null;
  /** Location keys (`conversationId` or `conversationId:threadId`), newest first. */
  keys: string[];
  /** The conversation (and task) on screen, if any. */
  current: CurrentLocation | null;
  load: (userId: string | null) => Promise<void>;
  visit: (key: string) => void;
  enter: (location: CurrentLocation) => void;
  leave: (conversationId: string) => void;
}

let loadGeneration = 0;

/**
 * Places the user opened recently, from any entry point (sidebar, task panel,
 * Activity, the quick switcher). The quick switcher lists them first and
 * ranks them higher. Kept per signed-in user, on this device only.
 */
export const useRecentLocationsStore = create<RecentLocationsStore>()((set, get) => ({
  userId: null,
  keys: [],
  current: null,

  enter: (location) => {
    const current = get().current;
    if (
      current?.conversationId !== location.conversationId ||
      current.threadId !== location.threadId ||
      current.type !== location.type
    ) {
      set({ current: location });
    }
    get().visit(
      location.threadId ? `${location.conversationId}:${location.threadId}` : location.conversationId,
    );
  },

  leave: (conversationId) => {
    if (get().current?.conversationId === conversationId) set({ current: null });
  },

  load: async (userId) => {
    const generation = ++loadGeneration;
    if (!userId) {
      set({ userId: null, keys: [] });
      return;
    }
    // Visits made while the stored list loads are kept, newest first.
    set((state) => (state.userId === userId ? state : { userId, keys: [] }));
    let stored: StoredRecents | null = null;
    try {
      const raw = await preferences.get(KV_KEY);
      stored = raw ? (JSON.parse(raw) as StoredRecents) : null;
    } catch {
      stored = null;
    }
    if (generation !== loadGeneration || get().userId !== userId) return;
    const saved =
      stored?.userId === userId && Array.isArray(stored.keys)
        ? stored.keys.filter((key): key is string => typeof key === "string")
        : [];
    set((state) => ({
      keys: [...new Set([...state.keys, ...saved])].slice(0, MAX_RECENT),
    }));
  },

  visit: (key) => {
    const { userId, keys } = get();
    if (!userId || !key || keys[0] === key) return;
    const next = [key, ...keys.filter((existing) => existing !== key)].slice(0, MAX_RECENT);
    set({ keys: next });
    void preferences.set(KV_KEY, JSON.stringify({ userId, keys: next } satisfies StoredRecents)).catch(() => {});
  },
}));
