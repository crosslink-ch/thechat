import { create } from "zustand";
import type {
  BotInvocationProgressEventPublic,
  BotInvocationPublic,
  BotRuntimeSnapshot,
  BotSessionPublic,
} from "@thechat/shared";
import { API_URL } from "../lib/api";
import {
  mergeRuntimeProgressEvent,
  mergeRuntimeUpdate,
} from "../lib/bot-runtime-state";

const RUNTIME_CACHE_TTL_MS = 60_000;

interface BotRuntimeEntry {
  runtime: BotRuntimeSnapshot | null;
  loading: boolean;
  loadedAt: number | null;
  error: string | null;
}

interface BotRuntimeStore {
  entries: Record<string, BotRuntimeEntry>;
  activeSessionIds: Record<string, string | null>;
  fetchRuntime: (
    conversationId: string,
    token: string,
    options?: { force?: boolean },
  ) => Promise<void>;
  updateRuntime: (
    conversationId: string,
    updater: (runtime: BotRuntimeSnapshot | null) => BotRuntimeSnapshot,
  ) => void;
  mergeInvocationUpdate: (
    conversationId: string,
    session: BotSessionPublic | null,
    invocation: BotInvocationPublic,
  ) => void;
  mergeProgressEvent: (
    conversationId: string,
    event: BotInvocationProgressEventPublic,
  ) => void;
  setActiveSessionId: (conversationId: string, sessionId: string | null) => void;
  clear: () => void;
}

const inflightLoads = new Map<string, Promise<void>>();

export const useBotRuntimeStore = create<BotRuntimeStore>()((set, get) => ({
  entries: {},
  activeSessionIds: {},

  fetchRuntime: async (conversationId, token, options = {}) => {
    const entry = get().entries[conversationId];
    const hasFreshRuntime =
      !!entry?.runtime &&
      !!entry.loadedAt &&
      Date.now() - entry.loadedAt < RUNTIME_CACHE_TTL_MS;

    if (!options.force && hasFreshRuntime) return;

    const inflight = inflightLoads.get(conversationId);
    if (inflight) return inflight;

    const promise = fetchRuntime(conversationId, token, entry?.runtime ?? null)
      .catch(() => {})
      .finally(() => {
        inflightLoads.delete(conversationId);
      });
    inflightLoads.set(conversationId, promise);
    return promise;
  },

  updateRuntime: (conversationId, updater) => {
    set((state) => {
      const current = state.entries[conversationId] ?? emptyEntry();
      const runtime = updater(current.runtime);
      return {
        entries: {
          ...state.entries,
          [conversationId]: {
            ...current,
            runtime,
            loadedAt: Date.now(),
            error: null,
          },
        },
      };
    });
  },

  mergeInvocationUpdate: (conversationId, session, invocation) => {
    get().updateRuntime(conversationId, (runtime) =>
      mergeRuntimeUpdate(runtime, session, invocation),
    );
  },

  mergeProgressEvent: (conversationId, event) => {
    get().updateRuntime(conversationId, (runtime) =>
      mergeRuntimeProgressEvent(runtime, event),
    );
  },

  setActiveSessionId: (conversationId, sessionId) => {
    set((state) => ({
      activeSessionIds: {
        ...state.activeSessionIds,
        [conversationId]: sessionId,
      },
    }));
  },

  clear: () => {
    inflightLoads.clear();
    set({ entries: {}, activeSessionIds: {} });
  },
}));

function emptyEntry(): BotRuntimeEntry {
  return {
    runtime: null,
    loading: false,
    loadedAt: null,
    error: null,
  };
}

async function fetchRuntime(
  conversationId: string,
  token: string,
  cachedRuntime: BotRuntimeSnapshot | null,
) {
  useBotRuntimeStore.setState((state) => {
    const current = state.entries[conversationId] ?? emptyEntry();
    return {
      entries: {
        ...state.entries,
        [conversationId]: {
          ...current,
          loading: true,
          error: null,
        },
      },
    };
  });

  try {
    const response = await fetch(`${API_URL}/bot-runtime/conversations/${conversationId}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new Error(`Request failed with HTTP ${response.status}`);
    const runtime = (await response.json()) as BotRuntimeSnapshot;
    useBotRuntimeStore.setState((state) => ({
      entries: {
        ...state.entries,
        [conversationId]: {
          runtime,
          loading: false,
          loadedAt: Date.now(),
          error: null,
        },
      },
    }));
  } catch (error) {
    useBotRuntimeStore.setState((state) => {
      const current = state.entries[conversationId] ?? emptyEntry();
      return {
        entries: {
          ...state.entries,
          [conversationId]: {
            ...current,
            runtime: current.runtime ?? cachedRuntime,
            loading: false,
            error: error instanceof Error ? error.message : "Failed to load runtime",
          },
        },
      };
    });
  }
}
