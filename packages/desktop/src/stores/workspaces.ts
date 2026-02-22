import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { WorkspaceListItem, WorkspaceWithDetails } from "@thechat/shared";
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
  joinWorkspace: (id: string) => Promise<void>;
  reset: () => void;
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

export const useWorkspacesStore = create<WorkspacesStore>((set) => ({
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

  joinWorkspace: async (workspaceId: string) => {
    const token = useAuthStore.getState().token;
    if (!token) return;

    const { error } = await api.workspaces.join.post({ workspaceId }, auth(token));
    if (error) throw new Error((error as any).error || "Request failed");

    const list = await fetchWorkspacesList(token);
    set({ workspaces: list });

    // Select the joined workspace
    try {
      const res = await api.workspaces({ id: workspaceId }).get(auth(token));
      if (!res.error) {
        set({ activeWorkspace: res.data as WorkspaceWithDetails });
        await kvSet(KV_ACTIVE_WORKSPACE, workspaceId);
      }
    } catch {
      // ignore
    }
  },

  reset: () => {
    set({ workspaces: [], activeWorkspace: null, loading: false });
  },
}));
