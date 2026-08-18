import { create } from "zustand";

interface PresenceStore {
  onlineUserIds: Set<string>;
  replaceOnlineUsers: (userIds: string[]) => void;
  setUserOnline: (userId: string, online: boolean) => void;
  clear: () => void;
}

export const usePresenceStore = create<PresenceStore>()((set) => ({
  onlineUserIds: new Set(),

  replaceOnlineUsers: (userIds) => {
    set({ onlineUserIds: new Set(userIds) });
  },

  setUserOnline: (userId, online) => {
    set((state) => {
      const onlineUserIds = new Set(state.onlineUserIds);
      if (online) onlineUserIds.add(userId);
      else onlineUserIds.delete(userId);
      return { onlineUserIds };
    });
  },

  clear: () => {
    set({ onlineUserIds: new Set() });
  },
}));
