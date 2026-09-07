import { create } from "zustand";
import type { ActivityItem, ActivitySnapshot, ChatMessage } from "@thechat/shared";
import { api } from "../lib/api";
import { edenErrorMessage } from "../lib/eden";
import { useAuthStore } from "./auth";
import { useConversationsStore } from "./conversations";

interface ActivityState extends ActivitySnapshot {
  loading: boolean;
  error: string | null;
  fetchActivity: () => Promise<void>;
  markConversationRead: (
    conversationId: string,
    messageIds?: string[],
  ) => Promise<void>;
  markAllRead: () => Promise<void>;
  handleIncomingMessage: (
    message: ChatMessage,
    conversationVisible: boolean,
  ) => Promise<void>;
  reset: () => void;
}

let activityFetchGeneration = 0;
let activityMutationVersion = 0;
let activityMutationRequestCounter = 0;
let latestActivityMutationRequest = 0;
let activityOperationCounter = 0;
let latestActivityOperation = 0;

function authHeaders(token: string) {
  return { headers: { authorization: `Bearer ${token}` } };
}

function normalizeSnapshot(value: unknown): ActivitySnapshot {
  if (!value || typeof value !== "object") {
    throw new Error("Failed to load activity");
  }
  const candidate = value as Partial<ActivitySnapshot>;
  if (
    !Array.isArray(candidate.items) ||
    typeof candidate.totalUnreadMessages !== "number"
  ) {
    throw new Error("Failed to load activity");
  }
  return {
    items: candidate.items as ActivityItem[],
    totalUnreadMessages: candidate.totalUnreadMessages,
  };
}

function currentToken() {
  return useAuthStore.getState().token;
}

function syncConversationUnread(snapshot: ActivitySnapshot) {
  useConversationsStore.setState({
    unreadChannels: new Set(
      snapshot.items
        .filter((item) => item.conversationType === "group")
        .map((item) => item.conversationId),
    ),
    unreadDirectConversations: Object.fromEntries(
      snapshot.items
        .filter((item) => item.conversationType === "direct")
        .map((item) => [item.conversationId, item.latestMessage.senderId]),
    ),
  });
}

export const useActivityStore = create<ActivityState>((set, get) => ({
  items: [],
  totalUnreadMessages: 0,
  loading: false,
  error: null,

  fetchActivity: async () => {
    const token = currentToken();
    if (!token) return;

    const requestGeneration = ++activityFetchGeneration;
    const operation = ++activityOperationCounter;
    latestActivityOperation = operation;
    const mutationVersion = activityMutationVersion;
    set({ loading: true, error: null });
    try {
      const { data, error } = await api.activity.get(authHeaders(token));
      if (
        requestGeneration !== activityFetchGeneration ||
        operation !== latestActivityOperation ||
        currentToken() !== token
      ) {
        return;
      }
      if (error) {
        throw new Error(edenErrorMessage(error, "Failed to load activity"));
      }
      if (mutationVersion !== activityMutationVersion) {
        void get().fetchActivity();
        return;
      }
      const snapshot = normalizeSnapshot(data);
      set({ ...snapshot, error: null });
      syncConversationUnread(snapshot);
    } catch (error) {
      if (
        requestGeneration === activityFetchGeneration &&
        operation === latestActivityOperation &&
        currentToken() === token
      ) {
        set({
          error:
            error instanceof Error ? error.message : "Failed to load activity",
        });
      }
    } finally {
      if (
        requestGeneration === activityFetchGeneration &&
        currentToken() === token
      ) {
        set({ loading: false });
      }
    }
  },

  markConversationRead: async (conversationId, messageIds) => {
    const token = currentToken();
    if (!token) return;
    const mutationRequest = ++activityMutationRequestCounter;
    latestActivityMutationRequest = mutationRequest;
    const operation = ++activityOperationCounter;
    latestActivityOperation = operation;
    activityMutationVersion += 1;
    set({ error: null });

    const endpoint = api.activity.conversations({ conversationId }).read;
    const body = messageIds ? { messageIds } : { all: true as const };
    const { data, error } = await endpoint
      .post(body, authHeaders(token))
      .finally(() => {
        activityMutationVersion += 1;
      });
    if (error) {
      const message = edenErrorMessage(error, "Failed to mark activity as read");
      if (
        currentToken() === token &&
        mutationRequest === latestActivityMutationRequest &&
        operation === latestActivityOperation
      ) {
        set({ error: message });
      }
      throw new Error(message);
    }
    if (
      currentToken() === token &&
      mutationRequest === latestActivityMutationRequest &&
      operation === latestActivityOperation
    ) {
      const snapshot = normalizeSnapshot(data);
      set({ ...snapshot, error: null });
      syncConversationUnread(snapshot);
    } else if (currentToken() === token) {
      await get().fetchActivity();
    }
  },

  markAllRead: async () => {
    const token = currentToken();
    if (!token) return;
    const mutationRequest = ++activityMutationRequestCounter;
    latestActivityMutationRequest = mutationRequest;
    const operation = ++activityOperationCounter;
    latestActivityOperation = operation;
    activityMutationVersion += 1;
    set({ error: null });

    const { data, error } = await api.activity["read-all"].post(
      {},
      authHeaders(token),
    ).finally(() => {
      activityMutationVersion += 1;
    });
    if (error) {
      const message = edenErrorMessage(error, "Failed to mark all activity as read");
      if (
        currentToken() === token &&
        mutationRequest === latestActivityMutationRequest &&
        operation === latestActivityOperation
      ) {
        set({ error: message });
      }
      throw new Error(message);
    }
    if (
      currentToken() === token &&
      mutationRequest === latestActivityMutationRequest &&
      operation === latestActivityOperation
    ) {
      const snapshot = normalizeSnapshot(data);
      set({ ...snapshot, error: null });
      syncConversationUnread(snapshot);
    } else if (currentToken() === token) {
      await get().fetchActivity();
    }
  },

  handleIncomingMessage: async (message, _conversationVisible) => {
    const currentUserId = useAuthStore.getState().user?.id;
    if (currentUserId && message.senderId === currentUserId) return;
    // Always reconcile from the server. A selected DM can render only one Hermes
    // thread, so conversation-level route visibility cannot prove this message
    // is actually on screen. The rendered-message hook clears it if it is.
    await get().fetchActivity();
  },

  reset: () => {
    activityFetchGeneration += 1;
    activityMutationVersion += 1;
    latestActivityMutationRequest = ++activityMutationRequestCounter;
    latestActivityOperation = ++activityOperationCounter;
    set({
      items: [],
      totalUnreadMessages: 0,
      loading: false,
      error: null,
    });
    syncConversationUnread({ items: [], totalUnreadMessages: 0 });
  },
}));
