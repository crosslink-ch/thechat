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

let notificationMutationGeneration = 0;
let notificationFetchGeneration = 0;

function markNotificationsChanged() {
  notificationMutationGeneration += 1;
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

function errorStatus(error: unknown) {
  if (error && typeof error === "object" && "status" in error) {
    const status = (error as { status?: unknown }).status;
    return typeof status === "number" ? status : undefined;
  }
  return undefined;
}

export const useNotificationsStore = create<NotificationsState>((set, get) => ({
  notifications: [],
  loading: false,
  error: null,

  fetchNotifications: async () => {
    const token = useAuthStore.getState().token;
    if (!token) return;

    const requestGeneration = ++notificationFetchGeneration;
    const mutationGeneration = notificationMutationGeneration;
    set({ loading: true, error: null });

    try {
      const [workspaceInvites, botInvites] = await Promise.all([
        api.invites.pending.get({ headers: authHeaders(token) }),
        api["bot-workspace-invites"].pending.get({
          headers: authHeaders(token),
        }),
      ]);

      if (
        requestGeneration !== notificationFetchGeneration ||
        useAuthStore.getState().token !== token
      ) {
        return;
      }

      if (workspaceInvites.error) {
        throw new Error(
          errorMessage(
            workspaceInvites.error,
            "Failed to load workspace invitations",
          ),
        );
      }
      if (botInvites.error) {
        throw new Error(
          errorMessage(botInvites.error, "Failed to load bot approval requests"),
        );
      }

      const workspaceData = workspaceInvites.data;
      const botData = botInvites.data;
      if (!Array.isArray(workspaceData) || !Array.isArray(botData)) {
        throw new Error("Failed to load notifications");
      }

      if (mutationGeneration !== notificationMutationGeneration) {
        void get().fetchNotifications();
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
        error: null,
      });
    } catch (error) {
      if (
        requestGeneration === notificationFetchGeneration &&
        useAuthStore.getState().token === token
      ) {
        set({
          error:
            error instanceof Error
              ? error.message
              : "Failed to load notifications",
        });
      }
    } finally {
      if (
        requestGeneration === notificationFetchGeneration &&
        useAuthStore.getState().token === token
      ) {
        set({ loading: false });
      }
    }
  },

  acceptInvite: async (inviteId) => {
    const token = useAuthStore.getState().token;
    if (!token) return;

    markNotificationsChanged();
    const result = await api.invites.accept.post(
      { inviteId },
      { headers: authHeaders(token) },
    );
    if (result.error) {
      if ([404, 409].includes(errorStatus(result.error) ?? 0)) {
        await get().fetchNotifications();
      }
      throw new Error(
        errorMessage(result.error, "Failed to accept workspace invitation"),
      );
    }

    markNotificationsChanged();
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

    markNotificationsChanged();
    const result = await api.invites.decline.post(
      { inviteId },
      { headers: authHeaders(token) },
    );
    if (result.error) {
      if ([404, 409].includes(errorStatus(result.error) ?? 0)) {
        await get().fetchNotifications();
      }
      throw new Error(
        errorMessage(result.error, "Failed to decline workspace invitation"),
      );
    }

    markNotificationsChanged();
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

    markNotificationsChanged();
    const result = await api["bot-workspace-invites"].accept.post(
      { inviteId },
      { headers: authHeaders(token) },
    );
    if (result.error) {
      if ([404, 409].includes(errorStatus(result.error) ?? 0)) {
        await get().fetchNotifications();
      }
      throw new Error(
        errorMessage(result.error, "Failed to approve bot request"),
      );
    }

    markNotificationsChanged();
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

    markNotificationsChanged();
    const result = await api["bot-workspace-invites"].decline.post(
      { inviteId },
      { headers: authHeaders(token) },
    );
    if (result.error) {
      if ([404, 409].includes(errorStatus(result.error) ?? 0)) {
        await get().fetchNotifications();
      }
      throw new Error(
        errorMessage(result.error, "Failed to decline bot request"),
      );
    }

    markNotificationsChanged();
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
    markNotificationsChanged();
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
      markNotificationsChanged();
      set((state) => ({
        notifications: state.notifications.filter(
          (candidate) => candidate.invite.id !== event.inviteId,
        ),
      }));
      return;
    }

    if (!notification) return;
    markNotificationsChanged();
    const key = notificationKey(notification);
    if (get().notifications.some((candidate) => notificationKey(candidate) === key)) {
      return;
    }
    set((state) => ({
      notifications: [...state.notifications, notification!],
    }));
  },

  reset: () => {
    markNotificationsChanged();
    notificationFetchGeneration += 1;
    set({ notifications: [], loading: false, error: null });
  },
}));
