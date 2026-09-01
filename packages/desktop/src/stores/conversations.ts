import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { Conversation } from "../core/types";

interface ConversationsStore {
  conversations: Conversation[];
  unreadAgentChats: Set<string>;
  unreadChannels: Set<string>;
  directConversationIdsByUserId: Record<string, string>;
  unreadDirectConversations: Record<string, string>;
  unreadConversationWorkspaceIds: Record<string, string>;
  activeDirectConversationId: string | null;
  fetchConversations: () => Promise<void>;
  markAgentChatRead: (id: string) => void;
  markAgentChatUnread: (id: string) => void;
  markChannelRead: (id: string) => void;
  markChannelUnread: (id: string, workspaceId: string | null) => void;
  rememberDirectConversation: (userId: string, conversationId: string) => void;
  setActiveDirectConversation: (conversationId: string | null) => void;
  markDirectConversationUnread: (
    conversationId: string,
    userId: string,
    workspaceId: string | null,
  ) => void;
}

export const useConversationsStore = create<ConversationsStore>()((set) => ({
  conversations: [],
  unreadAgentChats: new Set(),
  unreadChannels: new Set(),
  directConversationIdsByUserId: {},
  unreadDirectConversations: {},
  unreadConversationWorkspaceIds: {},
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
      const wasUnread = state.unreadChannels.has(id);
      const hadWorkspace = id in state.unreadConversationWorkspaceIds;
      if (!wasUnread && !hadWorkspace) return state;

      const unreadChannels = new Set(state.unreadChannels);
      unreadChannels.delete(id);
      const unreadConversationWorkspaceIds = {
        ...state.unreadConversationWorkspaceIds,
      };
      delete unreadConversationWorkspaceIds[id];
      return { unreadChannels, unreadConversationWorkspaceIds };
    });
  },

  markChannelUnread: (id: string, workspaceId: string | null) => {
    set((state) => {
      const alreadyUnread = state.unreadChannels.has(id);
      const workspaceAlreadyTracked =
        workspaceId === null ||
        state.unreadConversationWorkspaceIds[id] === workspaceId;
      if (alreadyUnread && workspaceAlreadyTracked) return state;

      const unreadChannels = alreadyUnread
        ? state.unreadChannels
        : new Set(state.unreadChannels).add(id);
      const unreadConversationWorkspaceIds =
        workspaceId === null || workspaceAlreadyTracked
          ? state.unreadConversationWorkspaceIds
          : {
              ...state.unreadConversationWorkspaceIds,
              [id]: workspaceId,
            };
      return { unreadChannels, unreadConversationWorkspaceIds };
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
      const wasUnread =
        conversationId !== null &&
        !!state.unreadDirectConversations[conversationId];
      const hadWorkspace =
        conversationId !== null &&
        conversationId in state.unreadConversationWorkspaceIds;
      if (
        state.activeDirectConversationId === conversationId &&
        !wasUnread &&
        !hadWorkspace
      ) {
        return state;
      }

      if (!wasUnread && !hadWorkspace) {
        return { activeDirectConversationId: conversationId };
      }
      const unreadDirectConversations = { ...state.unreadDirectConversations };
      const unreadConversationWorkspaceIds = {
        ...state.unreadConversationWorkspaceIds,
      };
      delete unreadDirectConversations[conversationId];
      delete unreadConversationWorkspaceIds[conversationId];
      return {
        activeDirectConversationId: conversationId,
        unreadDirectConversations,
        unreadConversationWorkspaceIds,
      };
    });
  },

  markDirectConversationUnread: (conversationId, userId, workspaceId) => {
    set((state) => {
      const knownConversation =
        state.directConversationIdsByUserId[userId] === conversationId;
      const alreadyUnread =
        state.unreadDirectConversations[conversationId] === userId;
      const isActive = state.activeDirectConversationId === conversationId;
      const workspaceAlreadyTracked =
        workspaceId === null ||
        state.unreadConversationWorkspaceIds[conversationId] === workspaceId;
      if (
        knownConversation &&
        (isActive || (alreadyUnread && workspaceAlreadyTracked))
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
          isActive || alreadyUnread
            ? state.unreadDirectConversations
            : {
                ...state.unreadDirectConversations,
                [conversationId]: userId,
              },
        unreadConversationWorkspaceIds:
          isActive || workspaceId === null || workspaceAlreadyTracked
            ? state.unreadConversationWorkspaceIds
            : {
                ...state.unreadConversationWorkspaceIds,
                [conversationId]: workspaceId,
              },
      };
    });
  },
}));
