import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { Conversation } from "../core/types";

interface ConversationsStore {
  conversations: Conversation[];
  unreadAgentChats: Set<string>;
  unreadChannels: Set<string>;
  fetchConversations: () => Promise<void>;
  markAgentChatRead: (id: string) => void;
  markAgentChatUnread: (id: string) => void;
  markChannelRead: (id: string) => void;
  markChannelUnread: (id: string) => void;
}

export const useConversationsStore = create<ConversationsStore>((set) => ({
  conversations: [],
  unreadAgentChats: new Set(),
  unreadChannels: new Set(),

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
}));
