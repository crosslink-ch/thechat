import { onSessionReset, sessionGeneration } from "../lib/session-boundary";
import { create } from "zustand";
import { preferences, type PreferenceKey } from "../platform/preferences";
import { isWeb } from "../platform/environment";
import { authHeaders as auth } from "../lib/eden";
import type {
  WorkspaceChannel,
  WorkspaceListItem,
  WorkspaceWithDetails,
} from "@thechat/shared";
import { api } from "../lib/api";
import { useAuthStore } from "./auth";

const KV_ACTIVE_WORKSPACE = "active_workspace_id";
let workspaceSelectionGeneration = 0;
let workspaceInitializationGeneration = 0;

async function kvGet(key: PreferenceKey): Promise<string | null> {
  return preferences.get(key, useAuthStore.getState().user?.id);
}

async function kvSet(key: PreferenceKey, value: string): Promise<void> {
  return preferences.set(key, value, useAuthStore.getState().user?.id);
}

function authenticated(token: string | null) {
  return isWeb ? Boolean(useAuthStore.getState().user) : Boolean(token);
}

interface WorkspacesStore {
  workspaces: WorkspaceListItem[];
  activeWorkspace: WorkspaceWithDetails | null;
  loading: boolean;
  initialize: () => Promise<void>;
  selectWorkspace: (id: string) => Promise<boolean>;
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

async function fetchWorkspacesList(token: string | null): Promise<WorkspaceListItem[]> {
  try {
    const { data, error } = await api.workspaces.list.get(auth(token));
    if (error) throw new Error((error as any).error || "Request failed");
    return data as WorkspaceListItem[];
  } catch {
    return [];
  }
}

type WorkspaceUpdate = Partial<WorkspacesStore> | ((state: WorkspacesStore) => Partial<WorkspacesStore>);
function workspaceSession(set: (update: WorkspaceUpdate) => void) {
  const generation = sessionGeneration();
  const current = () => !isWeb || generation === sessionGeneration();
  return { current, commit: (update: WorkspaceUpdate) => { if (current()) set(update); } };
}

export const useWorkspacesStore = create<WorkspacesStore>()((set) => ({
  workspaces: [],
  activeWorkspace: null,
  loading: false,

  initialize: async () => {
    const session = workspaceSession(set);
    const token = useAuthStore.getState().token;
    if (!authenticated(token)) return;
    const initializationRequest = ++workspaceInitializationGeneration;
    const selectionGeneration = ++workspaceSelectionGeneration;

    const isCurrent = () =>
      session.current() &&
      initializationRequest === workspaceInitializationGeneration &&
      selectionGeneration === workspaceSelectionGeneration &&
      useAuthStore.getState().token === token;

    session.commit({ loading: true });
    try {
      const list = await fetchWorkspacesList(token);
      if (!isCurrent()) return;
      session.commit({ workspaces: list });

      const savedId = await kvGet(KV_ACTIVE_WORKSPACE);
      if (!isCurrent()) return;
      if (savedId && list.some((workspace) => workspace.id === savedId)) {
        const { data, error } = await api.workspaces({ id: savedId }).get(auth(token));
        if (!isCurrent()) return;
        if (error) {
          session.commit({ activeWorkspace: null });
          return;
        }
        session.commit({ activeWorkspace: data as WorkspaceWithDetails });
      }
    } catch {
      // A later initialize/select operation owns state once this request is stale.
    } finally {
      if (
        initializationRequest === workspaceInitializationGeneration &&
        useAuthStore.getState().token === token
      ) {
        session.commit({ loading: false });
      }
    }
  },

  selectWorkspace: async (id: string) => {
    const session = workspaceSession(set);
    const token = useAuthStore.getState().token;
    if (!authenticated(token)) return false;
    const requestGeneration = ++workspaceSelectionGeneration;
    const isCurrent = () =>
      session.current() &&
      requestGeneration === workspaceSelectionGeneration &&
      useAuthStore.getState().token === token;

    try {
      const { data, error } = await api.workspaces({ id }).get(auth(token));
      if (error) throw new Error((error as any).error || "Request failed");
      if (!isCurrent()) return false;
      await kvSet(KV_ACTIVE_WORKSPACE, id);
      if (!isCurrent()) return false;
      session.commit({ activeWorkspace: data as WorkspaceWithDetails });
      return true;
    } catch {
      return false;
    }
  },

  createWorkspace: async (name: string) => {
    const session = workspaceSession(set);
    const token = useAuthStore.getState().token;
    if (!authenticated(token)) return;

    const { data, error } = await api.workspaces.create.post({ name }, auth(token));
    if (error) throw new Error((error as any).error || "Request failed");

    const list = await fetchWorkspacesList(token);
    session.commit({ workspaces: list });

    // Select the new workspace
    const id = (data as any).id;
    try {
      const res = await api.workspaces({ id }).get(auth(token));
      if (!res.error) {
        session.commit({ activeWorkspace: res.data as WorkspaceWithDetails });
        if (session.current()) await kvSet(KV_ACTIVE_WORKSPACE, id);
      }
    } catch {
      // ignore
    }
  },

  createChannel: async (name: string) => {
    const session = workspaceSession(set);
    const token = useAuthStore.getState().token;
    const workspace = useWorkspacesStore.getState().activeWorkspace;
    if (!authenticated(token) || !workspace) throw new Error("Select a workspace first");

    const { data, error } = await api.conversations.channel.post(
      { workspaceId: workspace.id, name },
      auth(token),
    );
    if (error) throw new Error(apiErrorMessage(error));

    const channel = data as WorkspaceChannel;
    session.commit((state) => ({
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
    const session = workspaceSession(set);
    const token = useAuthStore.getState().token;
    const workspaceId = useWorkspacesStore.getState().activeWorkspace?.id;
    if (!authenticated(token) || !workspaceId) throw new Error("Select a workspace first");

    const { data, error } = await api.conversations
      .channel({ conversationId: channelId })
      .patch({ name }, auth(token));
    if (error) throw new Error(apiErrorMessage(error));

    const channel = data as WorkspaceChannel;
    session.commit((state) => ({
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
    const session = workspaceSession(set);
    const token = useAuthStore.getState().token;
    const workspaceId = useWorkspacesStore.getState().activeWorkspace?.id;
    if (!authenticated(token) || !workspaceId) throw new Error("Select a workspace first");

    const { error } = await api.conversations
      .channel({ conversationId: channelId })
      .delete(undefined, auth(token));
    if (error) throw new Error(apiErrorMessage(error));

    session.commit((state) => ({
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
    workspaceSelectionGeneration += 1;
    workspaceInitializationGeneration += 1;
    set({ workspaces: [], activeWorkspace: null, loading: false });
  },
}));

onSessionReset(() => useWorkspacesStore.getState().reset());
