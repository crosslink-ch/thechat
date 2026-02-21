import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import type {
  AuthUser,
  WorkspaceListItem,
  WorkspaceWithDetails,
} from "@thechat/shared";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:3000";
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

async function apiFetch(path: string, token: string, options?: RequestInit) {
  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...options?.headers,
    },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

export function useWorkspaces(
  user: AuthUser | null,
  token: string | null
) {
  const [workspaces, setWorkspaces] = useState<WorkspaceListItem[]>([]);
  const [activeWorkspace, setActiveWorkspace] =
    useState<WorkspaceWithDetails | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchWorkspaces = useCallback(async () => {
    if (!token) return;
    try {
      const data = await apiFetch("/workspaces/list", token);
      setWorkspaces(data);
      return data as WorkspaceListItem[];
    } catch {
      return [];
    }
  }, [token]);

  const selectWorkspace = useCallback(
    async (id: string) => {
      if (!token) return;
      try {
        const data = await apiFetch(`/workspaces/${id}`, token);
        setActiveWorkspace(data);
        await kvSet(KV_ACTIVE_WORKSPACE, id);
      } catch {
        // Workspace may have been deleted
        setActiveWorkspace(null);
        await kvDelete(KV_ACTIVE_WORKSPACE);
      }
    },
    [token]
  );

  const createWorkspace = useCallback(
    async (name: string) => {
      if (!token) return;
      const data = await apiFetch("/workspaces/create", token, {
        method: "POST",
        body: JSON.stringify({ name }),
      });
      await fetchWorkspaces();
      await selectWorkspace(data.id);
      return data;
    },
    [token, fetchWorkspaces, selectWorkspace]
  );

  const joinWorkspace = useCallback(
    async (workspaceId: string) => {
      if (!token) return;
      await apiFetch("/workspaces/join", token, {
        method: "POST",
        body: JSON.stringify({ workspaceId }),
      });
      await fetchWorkspaces();
      await selectWorkspace(workspaceId);
    },
    [token, fetchWorkspaces, selectWorkspace]
  );

  const refreshWorkspace = useCallback(async () => {
    if (!token || !activeWorkspace) return;
    await selectWorkspace(activeWorkspace.id);
  }, [token, activeWorkspace, selectWorkspace]);

  // Fetch workspaces on mount and restore active workspace
  useEffect(() => {
    if (!user || !token) {
      setWorkspaces([]);
      setActiveWorkspace(null);
      return;
    }

    setLoading(true);
    (async () => {
      try {
        const list = await fetchWorkspaces();
        const savedId = await kvGet(KV_ACTIVE_WORKSPACE);
        if (savedId && list && list.some((w) => w.id === savedId)) {
          await selectWorkspace(savedId);
        }
      } catch {
        // ignore
      } finally {
        setLoading(false);
      }
    })();
  }, [user, token]); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    workspaces,
    activeWorkspace,
    loading,
    selectWorkspace,
    createWorkspace,
    joinWorkspace,
    refreshWorkspace,
  };
}
