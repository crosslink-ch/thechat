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
let pendingWorkspaceSelection: number | null = null;

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
  loaded: boolean;
  error: string | null;
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
  const { data, error } = await api.workspaces.list.get(auth(token));
  if (error) throw new Error(apiErrorMessage(error));
  return data as WorkspaceListItem[];
}

type WorkspaceUpdate = Partial<WorkspacesStore> | ((state: WorkspacesStore) => Partial<WorkspacesStore>);
function workspaceSession(set: (update: WorkspaceUpdate) => void) {
  const generation = sessionGeneration();
  const userId = useAuthStore.getState().user?.id;
  const token = useAuthStore.getState().token;
  const current = () => generation === sessionGeneration() &&
    useAuthStore.getState().user?.id === userId &&
    useAuthStore.getState().token === token;
  return { current, commit: (update: WorkspaceUpdate) => { if (current()) set(update); } };
}

export const useWorkspacesStore = create<WorkspacesStore>()((set) => ({
  workspaces: [],
  activeWorkspace: null,
  loading: false,
  loaded: false,
  error: null,

  initialize: async () => {
    // Background recovery must not supersede a user's in-flight selection.
    if (pendingWorkspaceSelection !== null) return;
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
      session.commit((state) => ({
        workspaces: list,
        loaded: true,
        activeWorkspace: list.some((workspace) => workspace.id === state.activeWorkspace?.id)
          ? state.activeWorkspace : null,
      }));

      const savedId = await kvGet(KV_ACTIVE_WORKSPACE);
      if (!isCurrent()) return;
      if (savedId && list.some((workspace) => workspace.id === savedId)) {
        const { data, error } = await api.workspaces({ id: savedId }).get(auth(token));
        if (!isCurrent()) return;
        if (error) throw new Error(apiErrorMessage(error));
        session.commit({ activeWorkspace: data as WorkspaceWithDetails });
      }
      session.commit({ error: null });
    } catch {
      if (isCurrent()) session.commit({ error: "Unable to load workspaces." });
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
    pendingWorkspaceSelection = requestGeneration;
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
      session.commit({ activeWorkspace: data as WorkspaceWithDetails, error: null });
      return true;
    } catch {
      if (isCurrent()) session.commit({ error: "Unable to load workspace." });
      return false;
    } finally {
      if (pendingWorkspaceSelection === requestGeneration) pendingWorkspaceSelection = null;
    }
  },

  createWorkspace: async (name: string) => {
    const session = workspaceSession(set);
    const token = useAuthStore.getState().token;
    if (!authenticated(token)) return;

    const { data, error } = await api.workspaces.create.post({ name }, auth(token));
    if (error) throw new Error((error as any).error || "Request failed");

    if (!session.current()) return;
    // Creation is already committed server-side. Retain its ID and reconcile
    // through the read-only retry path; do not make the form repeat the POST.
    const created = { ...(data as WorkspaceListItem), role: "owner" as const };
    session.commit((state) => ({
      workspaces: [...state.workspaces.filter((workspace) => workspace.id !== created.id), created],
    }));
    try {
      await kvSet(KV_ACTIVE_WORKSPACE, created.id);
    } catch {
      session.commit({ error: "Workspace created, but unable to save its selection." });
      return;
    }
    if (session.current()) await useWorkspacesStore.getState().initialize();
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
    pendingWorkspaceSelection = null;
    set({ workspaces: [], activeWorkspace: null, loading: false, loaded: false, error: null });
  },
}));

onSessionReset(() => useWorkspacesStore.getState().reset());
