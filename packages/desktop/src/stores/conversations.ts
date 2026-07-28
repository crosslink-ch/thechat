import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { Conversation } from "../core/types";

interface ConversationsStore {
  conversations: Conversation[];
  unreadAgentChats: Set<string>;
  unreadChannels: Set<string>;
  directConversationIdsByUserId: Record<string, string>;
  unreadBotConversations: Record<string, string>;
  activeDirectConversationId: string | null;
  fetchConversations: () => Promise<void>;
  markAgentChatRead: (id: string) => void;
  markAgentChatUnread: (id: string) => void;
  markChannelRead: (id: string) => void;
  markChannelUnread: (id: string) => void;
  rememberDirectConversation: (userId: string, conversationId: string) => void;
  setActiveDirectConversation: (conversationId: string | null) => void;
  markBotConversationUnread: (conversationId: string, botUserId: string) => void;
}

export const useConversationsStore = create<ConversationsStore>()((set) => ({
  conversations: [],
  unreadAgentChats: new Set(),
  unreadChannels: new Set(),
  directConversationIdsByUserId: {},
  unreadBotConversations: {},
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
      const wasUnread = conversationId !== null && !!state.unreadBotConversations[conversationId];
      if (state.activeDirectConversationId === conversationId && !wasUnread) return state;

      if (!wasUnread) return { activeDirectConversationId: conversationId };
      const unreadBotConversations = { ...state.unreadBotConversations };
      delete unreadBotConversations[conversationId];
      return { activeDirectConversationId: conversationId, unreadBotConversations };
    });
  },

  markBotConversationUnread: (conversationId, botUserId) => {
    set((state) => {
      const knownConversation =
        state.directConversationIdsByUserId[botUserId] === conversationId;
      const alreadyUnread = state.unreadBotConversations[conversationId] === botUserId;
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
              [botUserId]: conversationId,
            },
        unreadBotConversations:
          state.activeDirectConversationId === conversationId || alreadyUnread
            ? state.unreadBotConversations
            : {
                ...state.unreadBotConversations,
                [conversationId]: botUserId,
              },
      };
    });
  },
}));
