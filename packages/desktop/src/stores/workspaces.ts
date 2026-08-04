import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type {
  WorkspaceChannel,
  WorkspaceListItem,
  WorkspaceWithDetails,
} from "@thechat/shared";
import { api } from "../lib/api";
import { useAuthStore } from "./auth";

const KV_ACTIVE_WORKSPACE = "active_workspace_id";

async function kvGet(key: string): Promise<string | null> {
  return invoke<string | null>("kv_get", { key });
}

async function kvSet(key: string, value: string): Promise<void> {
  return invoke("kv_set", { key, value });
}

async function kvDelete(key: string): Promise<void> {
  return invoke("kv_delete", { key });
}

function auth(token: string) {
  return { headers: { authorization: `Bearer ${token}` } };
}

interface WorkspacesStore {
  workspaces: WorkspaceListItem[];
  activeWorkspace: WorkspaceWithDetails | null;
  loading: boolean;
  initialize: () => Promise<void>;
  selectWorkspace: (id: string) => Promise<void>;
  createWorkspace: (name: string) => Promise<void>;
  createChannel: (name: string) => Promise<WorkspaceChannel>;
  renameChannel: (channelId: string, name: string) => Promise<WorkspaceChannel>;
  deleteChannel: (channelId: string) => Promise<void>;
  reset: () => void;
}

function apiErrorMessage(error: unknown, fallback = "Request failed") {
  if (!error || typeof error !== "object") return fallback;
  const direct = (error as { error?: unknown }).error;
  if (typeof direct === "string") return direct;
  const value = (error as { value?: unknown }).value;
  if (value && typeof value === "object") {
    const nested = (value as { error?: unknown }).error;
    if (typeof nested === "string") return nested;
  }
  return fallback;
}

export function upsertWorkspaceChannel(
  channels: WorkspaceChannel[],
  channel: WorkspaceChannel,
) {
  const index = channels.findIndex((existing) => existing.id === channel.id);
  if (index < 0) return [...channels, channel];
  return channels.map((existing, currentIndex) =>
    currentIndex === index ? channel : existing,
  );
}

export function updateExistingWorkspaceChannel(
  channels: WorkspaceChannel[],
  channel: WorkspaceChannel,
) {
  if (!channels.some((existing) => existing.id === channel.id)) return channels;
  return channels.map((existing) =>
    existing.id === channel.id ? channel : existing,
  );
}

async function fetchWorkspacesList(token: string): Promise<WorkspaceListItem[]> {
  try {
    const { data, error } = await api.workspaces.list.get(auth(token));
    if (error) throw new Error((error as any).error || "Request failed");
    return data as WorkspaceListItem[];
  } catch {
    return [];
  }
}

export const useWorkspacesStore = create<WorkspacesStore>()((set) => ({
  workspaces: [],
  activeWorkspace: null,
  loading: false,

  initialize: async () => {
    const token = useAuthStore.getState().token;
    if (!token) return;

    set({ loading: true });
    try {
      const list = await fetchWorkspacesList(token);
      set({ workspaces: list });

      const savedId = await kvGet(KV_ACTIVE_WORKSPACE);
      if (savedId && list.some((w) => w.id === savedId)) {
        // Select the saved workspace
        try {
          const { data, error } = await api.workspaces({ id: savedId }).get(auth(token));
          if (error) throw error;
          set({ activeWorkspace: data as WorkspaceWithDetails });
        } catch {
          set({ activeWorkspace: null });
          await kvDelete(KV_ACTIVE_WORKSPACE);
        }
      }
    } catch {
      // ignore
    } finally {
      set({ loading: false });
    }
  },

  selectWorkspace: async (id: string) => {
    const token = useAuthStore.getState().token;
    if (!token) return;

    try {
      const { data, error } = await api.workspaces({ id }).get(auth(token));
      if (error) throw new Error((error as any).error || "Request failed");
      set({ activeWorkspace: data as WorkspaceWithDetails });
      await kvSet(KV_ACTIVE_WORKSPACE, id);
    } catch {
      set({ activeWorkspace: null });
      await kvDelete(KV_ACTIVE_WORKSPACE);
    }
  },

  createWorkspace: async (name: string) => {
    const token = useAuthStore.getState().token;
    if (!token) return;

    const { data, error } = await api.workspaces.create.post({ name }, auth(token));
    if (error) throw new Error((error as any).error || "Request failed");

    const list = await fetchWorkspacesList(token);
    set({ workspaces: list });

    // Select the new workspace
    const id = (data as any).id;
    try {
      const res = await api.workspaces({ id }).get(auth(token));
      if (!res.error) {
        set({ activeWorkspace: res.data as WorkspaceWithDetails });
        await kvSet(KV_ACTIVE_WORKSPACE, id);
      }
    } catch {
      // ignore
    }
  },

  createChannel: async (name: string) => {
    const token = useAuthStore.getState().token;
    const workspace = useWorkspacesStore.getState().activeWorkspace;
    if (!token || !workspace) throw new Error("Select a workspace first");

    const { data, error } = await api.conversations.channel.post(
      { workspaceId: workspace.id, name },
      auth(token),
    );
    if (error) throw new Error(apiErrorMessage(error));

    const channel = data as WorkspaceChannel;
    set((state) => ({
      activeWorkspace:
        state.activeWorkspace?.id === workspace.id
          ? {
              ...state.activeWorkspace,
              channels: upsertWorkspaceChannel(
                state.activeWorkspace.channels,
                channel,
              ),
            }
          : state.activeWorkspace,
    }));
    return channel;
  },

  renameChannel: async (channelId: string, name: string) => {
    const token = useAuthStore.getState().token;
    const workspaceId = useWorkspacesStore.getState().activeWorkspace?.id;
    if (!token || !workspaceId) throw new Error("Select a workspace first");

    const { data, error } = await api.conversations
      .channel({ conversationId: channelId })
      .patch({ name }, auth(token));
    if (error) throw new Error(apiErrorMessage(error));

    const channel = data as WorkspaceChannel;
    set((state) => ({
      activeWorkspace:
        state.activeWorkspace?.id === workspaceId
          ? {
              ...state.activeWorkspace,
              channels: updateExistingWorkspaceChannel(
                state.activeWorkspace.channels,
                channel,
              ),
            }
          : state.activeWorkspace,
    }));
    return channel;
  },

  deleteChannel: async (channelId: string) => {
    const token = useAuthStore.getState().token;
    const workspaceId = useWorkspacesStore.getState().activeWorkspace?.id;
    if (!token || !workspaceId) throw new Error("Select a workspace first");

    const { error } = await api.conversations
      .channel({ conversationId: channelId })
      .delete(undefined, auth(token));
    if (error) throw new Error(apiErrorMessage(error));

    set((state) => ({
      activeWorkspace:
        state.activeWorkspace?.id === workspaceId
          ? {
              ...state.activeWorkspace,
              channels: state.activeWorkspace.channels.filter(
                (item) => item.id !== channelId,
              ),
            }
          : state.activeWorkspace,
    }));
  },

  reset: () => {
    set({ workspaces: [], activeWorkspace: null, loading: false });
  },
}));
