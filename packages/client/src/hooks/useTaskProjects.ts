import { useCallback, useEffect, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { TaskProjectPublic } from "@thechat/shared";
import { isAuthenticated } from "../lib/auth-identity";
import { api } from "../lib/api";
import { authHeaders, edenErrorMessage } from "../lib/eden";
import { wsEvents, type WsEvents } from "../lib/ws-events";

const TASK_PROJECTS_STALE_MS = 60_000;

export const taskProjectsQueryKey = (conversationId: string) =>
  ["task-projects", conversationId] as const;

async function fetchTaskProjects(conversationId: string, token: string | null) {
  const { data, error } = await api.conversations
    .projects({ conversationId })
    .get(authHeaders(token));
  if (error) throw new Error(edenErrorMessage(error, "Failed to load projects"));
  return (data as unknown as WireTaskProject[]).map(normalizeProject);
}

/**
 * Eden Treaty revives ISO timestamps in REST responses as `Date` objects,
 * while WebSocket events carry plain strings. Normalize both to the shared
 * string contract so the cache never holds mixed types.
 */
type WireTaskProject = Omit<TaskProjectPublic, "createdAt" | "updatedAt"> & {
  createdAt: string | Date;
  updatedAt: string | Date;
};

function toIsoString(value: string | Date) {
  return value instanceof Date ? value.toISOString() : value;
}

export function normalizeProject(project: WireTaskProject): TaskProjectPublic {
  return {
    ...project,
    createdAt: toIsoString(project.createdAt),
    updatedAt: toIsoString(project.updatedAt),
  };
}

/** Server-backed task projects for one conversation, kept live over WebSocket. */
export function useTaskProjects(
  conversationId: string | null,
  token: string | null,
  enabled = true,
) {
  const queryClient = useQueryClient();
  const queryKey = useMemo(
    () =>
      conversationId
        ? taskProjectsQueryKey(conversationId)
        : (["task-projects", "disabled"] as const),
    [conversationId],
  );
  const query = useQuery({
    queryKey,
    queryFn: () => fetchTaskProjects(conversationId!, token),
    enabled: enabled && !!conversationId && isAuthenticated(token),
    staleTime: TASK_PROJECTS_STALE_MS,
  });

  const upsert = useCallback(
    (project: TaskProjectPublic) => {
      if (!conversationId) return;
      queryClient.setQueryData<TaskProjectPublic[]>(
        taskProjectsQueryKey(conversationId),
        (previous) => upsertProject(previous, project),
      );
    },
    [conversationId, queryClient],
  );

  const remove = useCallback(
    (projectId: string) => {
      if (!conversationId) return;
      queryClient.setQueryData<TaskProjectPublic[]>(
        taskProjectsQueryKey(conversationId),
        (previous) => previous?.filter((project) => project.id !== projectId),
      );
    },
    [conversationId, queryClient],
  );

  const createProject = useCallback(
    async (name: string) => {
      if (!conversationId || !isAuthenticated(token)) return null;
      const { data, error } = await api.conversations
        .projects({ conversationId })
        .post({ name }, authHeaders(token));
      if (error) throw new Error(edenErrorMessage(error, "Could not create the project"));
      const project = normalizeProject(data as unknown as WireTaskProject);
      upsert(project);
      return project;
    },
    [conversationId, token, upsert],
  );

  const renameProject = useCallback(
    async (projectId: string, name: string) => {
      if (!conversationId || !isAuthenticated(token)) return null;
      const { data, error } = await api.conversations
        .projects({ conversationId })({ projectId })
        .patch({ name }, authHeaders(token));
      if (error) throw new Error(edenErrorMessage(error, "Could not rename the project"));
      const project = normalizeProject(data as unknown as WireTaskProject);
      upsert(project);
      return project;
    },
    [conversationId, token, upsert],
  );

  const deleteProject = useCallback(
    async (projectId: string) => {
      if (!conversationId || !isAuthenticated(token)) return;
      const { error } = await api.conversations
        .projects({ conversationId })({ projectId })
        .delete(undefined, authHeaders(token));
      if (error) throw new Error(edenErrorMessage(error, "Could not delete the project"));
      remove(projectId);
    },
    [conversationId, remove, token],
  );

  useEffect(() => {
    if (!conversationId || !enabled || !isAuthenticated(token)) return;
    const onUpdated = ({
      conversationId: eventConversationId,
      project,
    }: WsEvents["ws:task_project_updated"]) => {
      if (eventConversationId === conversationId) upsert(normalizeProject(project));
    };
    const onDeleted = ({
      conversationId: eventConversationId,
      projectId,
    }: WsEvents["ws:task_project_deleted"]) => {
      if (eventConversationId === conversationId) remove(projectId);
    };
    wsEvents.on("ws:task_project_updated", onUpdated);
    wsEvents.on("ws:task_project_deleted", onDeleted);
    return () => {
      wsEvents.off("ws:task_project_updated", onUpdated);
      wsEvents.off("ws:task_project_deleted", onDeleted);
    };
  }, [conversationId, enabled, remove, token, upsert]);

  return useMemo(
    () => ({
      projects: query.data ?? [],
      loading: query.isLoading,
      createProject,
      renameProject,
      deleteProject,
    }),
    [createProject, deleteProject, query.data, query.isLoading, renameProject],
  );
}

function upsertProject(
  previous: TaskProjectPublic[] | undefined,
  project: TaskProjectPublic,
) {
  const list = previous ?? [];
  const exists = list.some((item) => item.id === project.id);
  const next = exists
    ? list.map((item) => (item.id === project.id ? project : item))
    : [...list, project];
  return next.sort(
    (a, b) =>
      Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id),
  );
}
