import { create } from "zustand";
import type { AppNotification } from "@thechat/shared";
import { api } from "../lib/api";
import { useAuthStore } from "./auth";
import { useWorkspacesStore } from "./workspaces";

function auth(token: string) {
  return { headers: { authorization: `Bearer ${token}` } };
}

function getNotificationId(n: AppNotification): string {
  switch (n.type) {
    case "workspace_invite":
      return n.invite.id;
  }
}

interface NotificationsStore {
  notifications: AppNotification[];
  loading: boolean;
  fetchNotifications: () => Promise<void>;
  addNotification: (notification: AppNotification) => void;
  removeNotification: (type: AppNotification["type"], id: string) => void;
  acceptInvite: (inviteId: string) => Promise<void>;
  declineInvite: (inviteId: string) => Promise<void>;
  reset: () => void;
}

export const useNotificationsStore = create<NotificationsStore>()((set, get) => ({
  notifications: [],
  loading: false,

  fetchNotifications: async () => {
    const token = useAuthStore.getState().token;
    if (!token) return;

    set({ loading: true });
    try {
      const { data, error } = await api.invites.pending.get(auth(token));
      if (error) throw error;

      const inviteNotifications: AppNotification[] = (
        data as any[]
      ).map((invite) => ({
        type: "workspace_invite" as const,
        invite,
      }));

      set({ notifications: inviteNotifications });
    } catch {
      // ignore
    } finally {
      set({ loading: false });
    }
  },

  addNotification: (notification: AppNotification) => {
    const { notifications } = get();
    const newId = getNotificationId(notification);
    const exists = notifications.some(
      (n) =>
        n.type === notification.type && getNotificationId(n) === newId
    );
    if (!exists) {
      set({ notifications: [...notifications, notification] });
    }
  },

  removeNotification: (type: AppNotification["type"], id: string) => {
    set({
      notifications: get().notifications.filter(
        (n) => !(n.type === type && getNotificationId(n) === id)
      ),
    });
  },

  acceptInvite: async (inviteId: string) => {
    const token = useAuthStore.getState().token;
    if (!token) return;

    const { error } = await api.invites.accept.post(
      { inviteId },
      auth(token)
    );
    if (error) throw new Error((error as any).error || "Failed to accept invite");

    get().removeNotification("workspace_invite", inviteId);
    await useWorkspacesStore.getState().initialize();
  },

  declineInvite: async (inviteId: string) => {
    const token = useAuthStore.getState().token;
    if (!token) return;

    const { error } = await api.invites.decline.post(
      { inviteId },
      auth(token)
    );
    if (error) throw new Error((error as any).error || "Failed to decline invite");

    get().removeNotification("workspace_invite", inviteId);
  },

  reset: () => {
    set({ notifications: [], loading: false });
  },
}));
