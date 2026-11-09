import { create } from "zustand";
import type { SearchDestination } from "@thechat/shared";
import { fetchSearchDirectory } from "../lib/search-api";
import { onSessionReset } from "../lib/session-boundary";
import { wsEvents, type WsEvents } from "../lib/ws-events";

/** How long a loaded directory is trusted before the next open refreshes it. */
const FRESH_MS = 30_000;

interface SearchDirectoryStore {
  destinations: SearchDestination[];
  loaded: boolean;
  loading: boolean;
  error: string | null;
  loadedAt: number;
  /** Load when missing or stale. Callers keep showing the cached list meanwhile. */
  ensure: () => Promise<void>;
  refresh: () => Promise<void>;
  markStale: () => void;
  /** Record a DM the quick switcher just opened, so the entry needs no reload. */
  rememberDirectConversation: (workspaceId: string, userId: string, conversationId: string) => void;
  reset: () => void;
}

let generation = 0;
let inFlight: Promise<void> | null = null;

const initialState = {
  destinations: [] as SearchDestination[],
  loaded: false,
  loading: false,
  error: null as string | null,
  loadedAt: 0,
};

/**
 * The quick switcher's list of every channel, person and recent Hermes task
 * the user can open. Loaded once per session and filtered on the device, so
 * typing in the switcher never waits on the network.
 */
export const useSearchDirectoryStore = create<SearchDirectoryStore>()((set, get) => ({
  ...initialState,

  ensure: async () => {
    const { loaded, loadedAt } = get();
    if (loaded && Date.now() - loadedAt < FRESH_MS) return;
    await get().refresh();
  },

  refresh: () => {
    if (inFlight) return inFlight;
    const requestGeneration = ++generation;
    set({ loading: true });
    inFlight = fetchSearchDirectory()
      .then((destinations) => {
        if (requestGeneration !== generation) return;
        set({ destinations, loaded: true, loading: false, error: null, loadedAt: Date.now() });
      })
      .catch((error: unknown) => {
        if (requestGeneration !== generation) return;
        set({
          loading: false,
          error: error instanceof Error ? error.message : "Could not load conversations",
        });
      })
      .finally(() => {
        if (requestGeneration === generation) inFlight = null;
      });
    return inFlight;
  },

  markStale: () => set({ loadedAt: 0 }),

  rememberDirectConversation: (workspaceId, userId, conversationId) =>
    set((state) => ({
      destinations: state.destinations.map((destination) =>
        destination.kind === "person" &&
        destination.workspaceId === workspaceId &&
        destination.userId === userId
          ? { ...destination, conversationId }
          : destination,
      ),
    })),

  reset: () => {
    generation += 1;
    inFlight = null;
    set({ ...initialState });
  },
}));

onSessionReset(() => useSearchDirectoryStore.getState().reset());

const STRUCTURAL_EVENTS = [
  "ws:member_joined",
  "ws:member_removed",
  "ws:member_updated",
  "ws:channel_created",
  "ws:channel_renamed",
  "ws:channel_deleted",
  "ws:conversation_thread_updated",
  "ws:conversation_thread_deleted",
] as const satisfies readonly (keyof WsEvents)[];

/**
 * Channel, membership and task changes make the next quick-switcher open
 * reload the directory. Nothing is fetched until the switcher is used.
 */
export function registerSearchDirectoryInvalidation() {
  const markStale = () => useSearchDirectoryStore.getState().markStale();
  for (const event of STRUCTURAL_EVENTS) wsEvents.on(event, markStale);
  return () => {
    for (const event of STRUCTURAL_EVENTS) wsEvents.off(event, markStale);
  };
}
