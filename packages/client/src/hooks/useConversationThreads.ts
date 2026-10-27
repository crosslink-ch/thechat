import { isAuthenticated } from "../lib/auth-identity";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ConversationThreadGroups,
  ConversationThreadPublic,
  ConversationThreadsPage,
} from "@thechat/shared";
import { api } from "../lib/api";
import { authHeaders, edenErrorMessage } from "../lib/eden";
import { wsEvents, type WsEvents } from "../lib/ws-events";
import {
  appendGroupPage,
  findLoadedThread,
  legacyTaskGroups,
  loadedThreads,
  normalizeThread,
  normalizeThreadPage,
  removeThread,
  revealThread,
  taskGroupSummaries,
  taskGroupsFromServer,
  touchThread as touchCachedThread,
  unfileProject,
  upsertThread,
  type TaskGroupsData,
} from "./task-groups-cache";

const CONVERSATION_THREADS_STALE_MS = 60_000;
const DEFAULT_THREAD_PAGE_SIZE = 50;

interface ConversationThreadsOptions {
  pageSize?: number;
  /**
   * The task the user has open. It is fetched on its own when it is not on a
   * loaded page, so opening an old task never falls back to General.
   */
  activeThreadId?: string | null;
}

export const conversationThreadsQueryKey = (
  conversationId: string,
  options: { pageSize?: number } = {},
) =>
  [
    "conversation-threads",
    conversationId,
    { pageSize: options.pageSize ?? DEFAULT_THREAD_PAGE_SIZE },
  ] as const;

class ThreadRequestError extends Error {
  constructor(message: string, readonly status: number | null) {
    super(message);
  }
}

function edenStatus(error: unknown) {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : null;
}

async function fetchThreadPage(
  conversationId: string,
  token: string | null,
  input: { limit: number; cursor?: string | null; projectId?: string | null; legacy?: boolean },
): Promise<ConversationThreadsPage> {
  const query: Record<string, string | number> = { limit: input.limit };
  if (input.cursor) query.cursor = input.cursor;
  if (!input.legacy && input.projectId !== undefined) {
    query.projectId = input.projectId ?? "none";
  }
  const { data, error } = await api.conversations.threads({ conversationId }).get({
    query,
    ...authHeaders(token),
  });
  if (error) {
    throw new ThreadRequestError(
      edenErrorMessage(error, "Failed to load task threads"),
      edenStatus(error),
    );
  }
  return normalizeThreadPage(data as unknown as ConversationThreadsPage);
}

/**
 * The first page of every task group. Servers that predate grouped paging
 * have no such route; they get the single recency-ordered list instead.
 */
async function fetchTaskGroups(
  conversationId: string,
  token: string | null,
  limit: number,
): Promise<TaskGroupsData> {
  const { data, error } = await api.conversations["thread-groups"]({ conversationId }).get({
    query: { limit },
    ...authHeaders(token),
  });
  if (!error) return taskGroupsFromServer(data as unknown as ConversationThreadGroups);
  if (edenStatus(error) !== 404) {
    throw new ThreadRequestError(
      edenErrorMessage(error, "Failed to load task threads"),
      edenStatus(error),
    );
  }
  return legacyTaskGroups(
    await fetchThreadPage(conversationId, token, { limit, legacy: true }),
  );
}

async function fetchConversationThread(
  conversationId: string,
  token: string | null,
  threadId: string,
) {
  const { data, error } = await api.conversations
    .threads({ conversationId })({ threadId })
    .get(authHeaders(token));
  if (error) {
    throw new ThreadRequestError(
      edenErrorMessage(error, "Failed to load the task"),
      edenStatus(error),
    );
  }
  return normalizeThread(data as unknown as ConversationThreadPublic);
}

async function createConversationThread(
  conversationId: string,
  token: string | null,
  input: {
    botId?: string;
    title?: string;
    branchFromThreadId?: string | null;
    projectId?: string | null;
  },
): Promise<ConversationThreadPublic> {
  const { data, error } = await api.conversations.threads({ conversationId }).post(
    input,
    authHeaders(token),
  );

  if (error) {
    throw new Error(edenErrorMessage(error, "Failed to create task thread"));
  }

  return normalizeThread(data as unknown as ConversationThreadPublic);
}

async function updateConversationThread(
  conversationId: string,
  token: string | null,
  input: { threadId: string; title?: string; projectId?: string | null },
): Promise<ConversationThreadPublic> {
  const { data, error } = await api.conversations.threads({ conversationId }).patch(
    input,
    authHeaders(token),
  );

  if (error) {
    throw new Error(edenErrorMessage(error, "Failed to update task thread"));
  }

  return normalizeThread(data as unknown as ConversationThreadPublic);
}

async function deleteConversationThread(
  conversationId: string,
  token: string | null,
  threadId: string,
) {
  const { error } = await api.conversations
    .threads({ conversationId })({ threadId })
    .delete(undefined, authHeaders(token));
  if (error) {
    throw new Error(edenErrorMessage(error, "Could not delete the task"));
  }
}

const groupKey = (projectId: string | null) => projectId ?? "none";

/** A task fetched on its own because it is on no loaded page. */
const singleThreadQueryKey = (conversationId: string | null, threadId: string | null) =>
  ["conversation-thread", conversationId, threadId] as const;

/** The task does not exist for this user (deleted, foreign or malformed id). */
function isGone(error: unknown) {
  const status = (error as ThreadRequestError | null)?.status;
  return status === 400 || status === 403 || status === 404;
}

/**
 * A conversation's Hermes tasks, paged per project group. Each project and
 * the tasks without one load their own pages, so a project whose tasks are
 * older than a page of newer tasks elsewhere still shows them.
 */
export function useConversationThreads(
  conversationId: string | null,
  token: string | null,
  enabled = true,
  options: ConversationThreadsOptions = {},
) {
  const queryClient = useQueryClient();
  const pageSize = options.pageSize ?? DEFAULT_THREAD_PAGE_SIZE;
  const activeThreadId = options.activeThreadId ?? null;
  const active = enabled && !!conversationId && isAuthenticated(token);
  const queryKey = useMemo(
    () =>
      conversationId
        ? conversationThreadsQueryKey(conversationId, { pageSize })
        : (["conversation-threads", "disabled"] as const),
    [conversationId, pageSize],
  );
  const query = useQuery({
    queryKey,
    queryFn: () => fetchTaskGroups(conversationId!, token, pageSize),
    enabled: active,
    staleTime: CONVERSATION_THREADS_STALE_MS,
  });
  const [loadingGroups, setLoadingGroups] = useState<ReadonlySet<string>>(() => new Set());
  const loadingGroupsRef = useRef(loadingGroups);
  loadingGroupsRef.current = loadingGroups;

  const threads = useMemo(() => loadedThreads(query.data), [query.data]);
  const groups = useMemo(
    () => taskGroupSummaries(query.data, (projectId) => loadingGroups.has(groupKey(projectId))),
    [loadingGroups, query.data],
  );

  const refetch = query.refetch;
  /** Applies a cache edit; a null result means the cache cannot tell, so reload. */
  const updateCache = useCallback(
    (edit: (data: TaskGroupsData) => TaskGroupsData | null) => {
      const data = queryClient.getQueryData<TaskGroupsData>(queryKey);
      if (!data) return;
      const next = edit(data);
      if (next) queryClient.setQueryData<TaskGroupsData>(queryKey, next);
      else void refetch();
    },
    [queryClient, queryKey, refetch],
  );

  const loadMore = useCallback(
    async (projectId: string | null = null) => {
      if (!conversationId || !active) return;
      const key = groupKey(projectId);
      if (loadingGroupsRef.current.has(key)) return;
      const data = queryClient.getQueryData<TaskGroupsData>(queryKey);
      const group = data?.groups.find((item) => item.projectId === projectId);
      if (!data || !group?.hasMore || !group.nextCursor) return;
      const cursor = group.nextCursor;
      setLoadingGroups((current) => new Set(current).add(key));
      try {
        const page = await fetchThreadPage(conversationId, token, {
          limit: pageSize,
          cursor,
          projectId,
          legacy: data.legacy,
        });
        updateCache((current) => appendGroupPage(current, projectId, cursor, page));
      } finally {
        setLoadingGroups((current) => {
          const next = new Set(current);
          next.delete(key);
          return next;
        });
      }
    },
    [active, conversationId, pageSize, queryClient, queryKey, token, updateCache],
  );

  const activeLoaded = !!activeThreadId && threads.some((thread) => thread.id === activeThreadId);
  const activeThreadQuery = useQuery({
    queryKey: singleThreadQueryKey(conversationId, activeThreadId),
    queryFn: () => fetchConversationThread(conversationId!, token, activeThreadId!),
    enabled: active && !!activeThreadId && query.isSuccess && !activeLoaded,
    staleTime: CONVERSATION_THREADS_STALE_MS,
    retry: (failureCount, error) => !isGone(error) && failureCount < 1,
  });
  const fetchedActiveThread = activeThreadQuery.data;
  useEffect(() => {
    if (activeLoaded || !fetchedActiveThread || fetchedActiveThread.id !== activeThreadId) return;
    updateCache((data) => revealThread(data, fetchedActiveThread));
  }, [activeLoaded, activeThreadId, fetchedActiveThread, updateCache]);
  const activeThreadMissing =
    !!activeThreadId && !activeLoaded && isGone(activeThreadQuery.error);

  const createThread = useCallback(
    async (
      input: {
        botId?: string;
        title?: string;
        branchFromThreadId?: string | null;
        projectId?: string | null;
      } = {},
    ) => {
      if (!conversationId || !isAuthenticated(token)) return null;
      const thread = await createConversationThread(conversationId, token, input);
      if (queryClient.getQueryData(queryKey)) {
        updateCache((data) => upsertThread(data, thread, { isNew: true }));
      } else {
        void queryClient.invalidateQueries({ queryKey });
      }
      return thread;
    },
    [conversationId, queryClient, queryKey, token, updateCache],
  );

  /** Stores a task the server returned; it may come from an unloaded page. */
  const applyServerThread = useCallback(
    (thread: ConversationThreadPublic) =>
      updateCache((data) => upsertThread(data, thread) ?? revealThread(data, thread)),
    [updateCache],
  );

  const renameThread = useCallback(
    async (threadId: string, title: string) => {
      if (!conversationId || !isAuthenticated(token)) return null;
      const thread = await updateConversationThread(conversationId, token, {
        threadId,
        title,
      });
      applyServerThread(thread);
      return thread;
    },
    [applyServerThread, conversationId, token],
  );

  /** Files a task under a project, or unfiles it with `null`. */
  const moveThread = useCallback(
    async (threadId: string, projectId: string | null) => {
      if (!conversationId || !isAuthenticated(token)) return null;
      const current = findLoadedThread(
        queryClient.getQueryData<TaskGroupsData>(queryKey),
        threadId,
      );
      // Optimistic so drag and drop feels immediate; rolled back on failure.
      if (current) updateCache((data) => upsertThread(data, { ...current, projectId }));
      try {
        const thread = await updateConversationThread(conversationId, token, {
          threadId,
          projectId,
        });
        applyServerThread(thread);
        return thread;
      } catch (error) {
        if (current) updateCache((data) => upsertThread(data, current));
        throw error;
      }
    },
    [applyServerThread, conversationId, queryClient, queryKey, token, updateCache],
  );

  const deleteThread = useCallback(
    async (threadId: string) => {
      if (!conversationId || !isAuthenticated(token)) return;
      await deleteConversationThread(conversationId, token, threadId);
      queryClient.removeQueries({ queryKey: singleThreadQueryKey(conversationId, threadId) });
      updateCache((data) => removeThread(data, threadId));
    },
    [conversationId, queryClient, token, updateCache],
  );

  const touchThread = useCallback(
    (threadId: string, at = new Date().toISOString()) => {
      if (!active) return;
      updateCache((data) => touchCachedThread(data, threadId, at));
    },
    [active, updateCache],
  );

  useEffect(() => {
    if (!active) return;

    const onConversationThreadUpdated = ({
      conversationId: eventConversationId,
      thread,
    }: WsEvents["ws:conversation_thread_updated"]) => {
      if (eventConversationId !== conversationId) return;
      // An update to a task no group has loaded leaves its old group unknown.
      updateCache((data) => upsertThread(data, normalizeThread(thread)));
    };

    const onConversationThreadDeleted = ({
      conversationId: eventConversationId,
      threadId,
    }: WsEvents["ws:conversation_thread_deleted"]) => {
      if (eventConversationId !== conversationId) return;
      // Never re-show a deleted task from its single-task cache.
      queryClient.removeQueries({ queryKey: singleThreadQueryKey(conversationId, threadId) });
      // A deleted task that was never loaded changes nothing on screen.
      const data = queryClient.getQueryData<TaskGroupsData>(queryKey);
      if (!findLoadedThread(data, threadId)) return;
      updateCache((current) => removeThread(current, threadId));
    };

    // Deleting a project unfiles its tasks on the server. Show that now, then
    // reload: its tasks that were never loaded may belong on the first page.
    const onTaskProjectDeleted = ({
      conversationId: eventConversationId,
      projectId,
    }: WsEvents["ws:task_project_deleted"]) => {
      if (eventConversationId !== conversationId) return;
      updateCache((data) => unfileProject(data, projectId));
      void queryClient.invalidateQueries({ queryKey });
    };

    wsEvents.on("ws:conversation_thread_updated", onConversationThreadUpdated);
    wsEvents.on("ws:conversation_thread_deleted", onConversationThreadDeleted);
    wsEvents.on("ws:task_project_deleted", onTaskProjectDeleted);
    return () => {
      wsEvents.off("ws:conversation_thread_updated", onConversationThreadUpdated);
      wsEvents.off("ws:conversation_thread_deleted", onConversationThreadDeleted);
      wsEvents.off("ws:task_project_deleted", onTaskProjectDeleted);
    };
  }, [active, conversationId, queryClient, queryKey, updateCache]);

  return useMemo(
    () => ({
      threads,
      groups,
      loading: query.isLoading,
      loadMore,
      createThread,
      renameThread,
      moveThread,
      deleteThread,
      touchThread,
      activeThreadMissing,
      refetchThreads: refetch,
    }),
    [
      activeThreadMissing,
      createThread,
      deleteThread,
      groups,
      loadMore,
      moveThread,
      query.isLoading,
      refetch,
      renameThread,
      threads,
      touchThread,
    ],
  );
}
