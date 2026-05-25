import { create } from "zustand";
import type { ConversationDetail } from "@thechat/shared";
import { API_URL } from "../lib/api";

const CONVERSATION_DETAIL_CACHE_TTL_MS = 5 * 60_000;

interface ConversationDetailEntry {
  detail: ConversationDetail | null;
  loading: boolean;
  loadedAt: number | null;
  error: string | null;
}

interface ConversationDetailsStore {
  entries: Record<string, ConversationDetailEntry>;
  fetchDetail: (
    conversationId: string,
    token: string,
    options?: { force?: boolean },
  ) => Promise<void>;
  clear: () => void;
}

const inflightLoads = new Map<string, Promise<void>>();

export const useConversationDetailsStore = create<ConversationDetailsStore>()((set, get) => ({
  entries: {},

  fetchDetail: async (conversationId, token, options = {}) => {
    const entry = get().entries[conversationId];
    const hasFreshDetail =
      !!entry?.detail &&
      !!entry.loadedAt &&
      Date.now() - entry.loadedAt < CONVERSATION_DETAIL_CACHE_TTL_MS;

    if (!options.force && hasFreshDetail) return;

    const inflight = inflightLoads.get(conversationId);
    if (inflight) return inflight;

    const promise = fetchDetail(conversationId, token)
      .catch(() => {})
      .finally(() => {
        inflightLoads.delete(conversationId);
      });
    inflightLoads.set(conversationId, promise);
    return promise;
  },

  clear: () => {
    inflightLoads.clear();
    set({ entries: {} });
  },
}));

function emptyEntry(): ConversationDetailEntry {
  return {
    detail: null,
    loading: false,
    loadedAt: null,
    error: null,
  };
}

async function fetchDetail(conversationId: string, token: string) {
  useConversationDetailsStore.setState((state) => {
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
    const response = await fetch(`${API_URL}/conversations/detail/${conversationId}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new Error(`Request failed with HTTP ${response.status}`);
    const detail = (await response.json()) as ConversationDetail;
    useConversationDetailsStore.setState((state) => ({
      entries: {
        ...state.entries,
        [conversationId]: {
          detail,
          loading: false,
          loadedAt: Date.now(),
          error: null,
        },
      },
    }));
  } catch (error) {
    useConversationDetailsStore.setState((state) => {
      const current = state.entries[conversationId] ?? emptyEntry();
      return {
        entries: {
          ...state.entries,
          [conversationId]: {
            ...current,
            loading: false,
            error: error instanceof Error ? error.message : "Failed to load conversation",
          },
        },
      };
    });
  }
}
