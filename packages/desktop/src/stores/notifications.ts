import { create } from "zustand";
import type {
  AppNotification,
  BotWorkspaceInvite,
  WorkspaceInvite,
  WsServerEvent,
} from "@thechat/shared";
import { api } from "../lib/api";
import { useAuthStore } from "./auth";
import { useWorkspacesStore } from "./workspaces";

interface NotificationsState {
  notifications: AppNotification[];
  loading: boolean;
  error: string | null;
  fetchNotifications: () => Promise<void>;
  acceptInvite: (inviteId: string) => Promise<void>;
  declineInvite: (inviteId: string) => Promise<void>;
  acceptBotWorkspaceInvite: (inviteId: string) => Promise<void>;
  declineBotWorkspaceInvite: (inviteId: string) => Promise<void>;
  addNotification: (notification: AppNotification) => void;
  handleRealtimeEvent: (event: WsServerEvent) => void;
  reset: () => void;
}

function notificationKey(notification: AppNotification) {
  return `${notification.type}:${notification.invite.id}`;
}

function authHeaders(token: string) {
  return { authorization: `Bearer ${token}` };
}

function errorMessage(error: unknown, fallback: string) {
  if (error && typeof error === "object" && "value" in error) {
    const value = (error as { value?: unknown }).value;
    if (value && typeof value === "object" && "error" in value) {
      return String((value as { error: unknown }).error);
    }
  }
  return fallback;
}

export const useNotificationsStore = create<NotificationsState>((set, get) => ({
  notifications: [],
  loading: false,
  error: null,

  fetchNotifications: async () => {
    const token = useAuthStore.getState().token;
    if (!token) return;

    set({ loading: true, error: null });
    const [workspaceInvites, botInvites] = await Promise.all([
      api.invites.pending.get({ headers: authHeaders(token) }),
      api["bot-workspace-invites"].pending.get({
        headers: authHeaders(token),
      }),
    ]);

    if (workspaceInvites.error) {
      set({
        loading: false,
        error: errorMessage(
          workspaceInvites.error,
          "Failed to load workspace invitations",
        ),
      });
      return;
    }
    if (botInvites.error) {
      set({
        loading: false,
        error: errorMessage(
          botInvites.error,
          "Failed to load bot approval requests",
        ),
      });
      return;
    }

    const workspaceData = workspaceInvites.data;
    const botData = botInvites.data;
    if (!Array.isArray(workspaceData) || !Array.isArray(botData)) {
      set({ loading: false, error: "Failed to load notifications" });
      return;
    }

    set({
      notifications: [
        ...(workspaceData as WorkspaceInvite[]).map(
          (invite): AppNotification => ({ type: "workspace_invite", invite }),
        ),
        ...(botData as BotWorkspaceInvite[]).map(
          (invite): AppNotification => ({
            type: "bot_workspace_invite",
            invite,
          }),
        ),
      ],
      loading: false,
    });
  },

  acceptInvite: async (inviteId) => {
    const token = useAuthStore.getState().token;
    if (!token) return;

    const result = await api.invites.accept.post(
      { inviteId },
      { headers: authHeaders(token) },
    );
    if (result.error) throw new Error("Failed to accept invite");

    set((state) => ({
      notifications: state.notifications.filter(
        (notification) =>
          !(
            notification.type === "workspace_invite" &&
            notification.invite.id === inviteId
          ),
      ),
    }));
    await useWorkspacesStore.getState().initialize();
  },

  declineInvite: async (inviteId) => {
    const token = useAuthStore.getState().token;
    if (!token) return;

    const result = await api.invites.decline.post(
      { inviteId },
      { headers: authHeaders(token) },
    );
    if (result.error) throw new Error("Failed to decline invite");

    set((state) => ({
      notifications: state.notifications.filter(
        (notification) =>
          !(
            notification.type === "workspace_invite" &&
            notification.invite.id === inviteId
          ),
      ),
    }));
  },

  acceptBotWorkspaceInvite: async (inviteId) => {
    const token = useAuthStore.getState().token;
    if (!token) return;

    const result = await api["bot-workspace-invites"].accept.post(
      { inviteId },
      { headers: authHeaders(token) },
    );
    if (result.error) throw new Error("Failed to approve bot request");

    set((state) => ({
      notifications: state.notifications.filter(
        (notification) =>
          !(
            notification.type === "bot_workspace_invite" &&
            notification.invite.id === inviteId
          ),
      ),
    }));
  },

  declineBotWorkspaceInvite: async (inviteId) => {
    const token = useAuthStore.getState().token;
    if (!token) return;

    const result = await api["bot-workspace-invites"].decline.post(
      { inviteId },
      { headers: authHeaders(token) },
    );
    if (result.error) throw new Error("Failed to decline bot request");

    set((state) => ({
      notifications: state.notifications.filter(
        (notification) =>
          !(
            notification.type === "bot_workspace_invite" &&
            notification.invite.id === inviteId
          ),
      ),
    }));
  },

  addNotification: (notification) => {
    const key = notificationKey(notification);
    if (get().notifications.some((candidate) => notificationKey(candidate) === key)) {
      return;
    }
    set((state) => ({
      notifications: [...state.notifications, notification],
    }));
  },

  handleRealtimeEvent: (event) => {
    let notification: AppNotification | null = null;
    if (event.type === "invite_received") {
      notification = { type: "workspace_invite", invite: event.invite };
    } else if (event.type === "bot_workspace_invite_received") {
      notification = {
        type: "bot_workspace_invite",
        invite: event.invite,
      };
    } else if (event.type === "bot_workspace_invite_resolved") {
      set((state) => ({
        notifications: state.notifications.filter(
          (candidate) => candidate.invite.id !== event.inviteId,
        ),
      }));
      return;
    }

    if (!notification) return;
    const key = notificationKey(notification);
    if (get().notifications.some((candidate) => notificationKey(candidate) === key)) {
      return;
    }
    set((state) => ({
      notifications: [...state.notifications, notification!],
    }));
  },

  reset: () => set({ notifications: [], loading: false, error: null }),
}));
