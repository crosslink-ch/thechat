import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { Conversation } from "../core/types";

interface ConversationsStore {
  conversations: Conversation[];
  unreadAgentChats: Set<string>;
  unreadChannels: Set<string>;
  directConversationIdsByUserId: Record<string, string>;
  unreadDirectConversations: Record<string, string>;
  activeDirectConversationId: string | null;
  fetchConversations: () => Promise<void>;
  markAgentChatRead: (id: string) => void;
  markAgentChatUnread: (id: string) => void;
  markChannelRead: (id: string) => void;
  markChannelUnread: (id: string) => void;
  rememberDirectConversation: (userId: string, conversationId: string) => void;
  setActiveDirectConversation: (conversationId: string | null) => void;
  markDirectConversationUnread: (conversationId: string, userId: string) => void;
}

export const useConversationsStore = create<ConversationsStore>()((set) => ({
  conversations: [],
  unreadAgentChats: new Set(),
  unreadChannels: new Set(),
  directConversationIdsByUserId: {},
  unreadDirectConversations: {},
  activeDirectConversationId: null,

  fetchConversations: async () => {
    const conversations = await invoke<Conversation[]>("list_conversations");
    set({ conversations });
  },

  markAgentChatRead: (id: string) => {
    set((state) => {
      if (!state.unreadAgentChats.has(id)) return state;
      const next = new Set(state.unreadAgentChats);
      next.delete(id);
      return { unreadAgentChats: next };
    });
  },

  markAgentChatUnread: (id: string) => {
    set((state) => {
      if (state.unreadAgentChats.has(id)) return state;
      const next = new Set(state.unreadAgentChats);
      next.add(id);
      return { unreadAgentChats: next };
    });
  },

  markChannelRead: (id: string) => {
    set((state) => {
      if (!state.unreadChannels.has(id)) return state;
      const next = new Set(state.unreadChannels);
      next.delete(id);
      return { unreadChannels: next };
    });
  },

  markChannelUnread: (id: string) => {
    set((state) => {
      if (state.unreadChannels.has(id)) return state;
      const next = new Set(state.unreadChannels);
      next.add(id);
      return { unreadChannels: next };
    });
  },

  rememberDirectConversation: (userId, conversationId) => {
    set((state) => {
      if (state.directConversationIdsByUserId[userId] === conversationId) return state;
      return {
        directConversationIdsByUserId: {
          ...state.directConversationIdsByUserId,
          [userId]: conversationId,
        },
      };
    });
  },

  setActiveDirectConversation: (conversationId) => {
    set((state) => {
      const wasUnread = conversationId !== null && !!state.unreadDirectConversations[conversationId];
      if (state.activeDirectConversationId === conversationId && !wasUnread) return state;

      if (!wasUnread) return { activeDirectConversationId: conversationId };
      const unreadDirectConversations = { ...state.unreadDirectConversations };
      delete unreadDirectConversations[conversationId];
      return { activeDirectConversationId: conversationId, unreadDirectConversations };
    });
  },

  markDirectConversationUnread: (conversationId, userId) => {
    set((state) => {
      const knownConversation =
        state.directConversationIdsByUserId[userId] === conversationId;
      const alreadyUnread = state.unreadDirectConversations[conversationId] === userId;
      if (
        knownConversation &&
        (state.activeDirectConversationId === conversationId || alreadyUnread)
      ) {
        return state;
      }

      return {
        directConversationIdsByUserId: knownConversation
          ? state.directConversationIdsByUserId
          : {
              ...state.directConversationIdsByUserId,
              [userId]: conversationId,
            },
        unreadDirectConversations:
          state.activeDirectConversationId === conversationId || alreadyUnread
            ? state.unreadDirectConversations
            : {
                ...state.unreadDirectConversations,
                [conversationId]: userId,
              },
      };
    });
  },
}));
