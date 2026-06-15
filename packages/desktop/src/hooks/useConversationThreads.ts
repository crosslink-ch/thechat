import { useCallback, useEffect, useMemo } from "react";
import {
  useInfiniteQuery,
  useQueryClient,
  type InfiniteData,
} from "@tanstack/react-query";
import type {
  ConversationThreadPublic,
  ConversationThreadsPage,
} from "@thechat/shared";
import { api } from "../lib/api";
import { authHeaders, edenErrorMessage } from "../lib/eden";
import { wsEvents, type WsEvents } from "../lib/ws-events";

const CONVERSATION_THREADS_STALE_MS = 60_000;
const DEFAULT_THREAD_PAGE_SIZE = 50;

interface ConversationThreadsOptions {
  botId?: string | null;
  status?: string | null;
  pageSize?: number;
}

type ThreadsInfiniteData = InfiniteData<ConversationThreadsPage, string | null>;

export const conversationThreadsQueryKey = (
  conversationId: string,
  options: ConversationThreadsOptions = {},
) =>
  [
    "conversation-threads",
    conversationId,
    {
      botId: options.botId ?? null,
      status: options.status ?? null,
      pageSize: options.pageSize ?? DEFAULT_THREAD_PAGE_SIZE,
    },
  ] as const;

async function fetchConversationThreads(
  conversationId: string,
  token: string,
  input: {
    cursor?: string | null;
    botId?: string | null;
    status?: string | null;
    limit: number;
  },
): Promise<ConversationThreadsPage> {
  const query: Record<string, string | number> = { limit: input.limit };
  if (input.cursor) query.cursor = input.cursor;
  if (input.botId) query.botId = input.botId;
  if (input.status) query.status = input.status;

  const { data, error } = await api.conversations.threads({ conversationId }).get(
    {
      query,
      ...authHeaders(token),
    },
  );

  if (error) {
    throw new Error(edenErrorMessage(error, "Failed to load task threads"));
  }

  return data as ConversationThreadsPage;
}

async function createConversationThread(
  conversationId: string,
  token: string,
  input: { botId?: string; title?: string; branchFromThreadId?: string | null },
): Promise<ConversationThreadPublic> {
  const { data, error } = await api.conversations.threads({ conversationId }).post(
    input,
    authHeaders(token),
  );

  if (error) {
    throw new Error(edenErrorMessage(error, "Failed to create task thread"));
  }

  return data as ConversationThreadPublic;
}

async function updateConversationThread(
  conversationId: string,
  token: string,
  input: { threadId: string; title: string },
): Promise<ConversationThreadPublic> {
  const { data, error } = await api.conversations.threads({ conversationId }).patch(
    input,
    authHeaders(token),
  );

  if (error) {
    throw new Error(edenErrorMessage(error, "Failed to update task thread"));
  }

  return data as ConversationThreadPublic;
}

export function useConversationThreads(
  conversationId: string | null,
  token: string | null,
  enabled = true,
  options: ConversationThreadsOptions = {},
) {
  const queryClient = useQueryClient();
  const botId = options.botId ?? null;
  const status = options.status ?? null;
  const pageSize = options.pageSize ?? DEFAULT_THREAD_PAGE_SIZE;
  const queryKey = useMemo(
    () =>
      conversationId
        ? conversationThreadsQueryKey(conversationId, { botId, status, pageSize })
        : (["conversation-threads", "disabled"] as const),
    [botId, conversationId, pageSize, status],
  );
  const query = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam }) =>
      fetchConversationThreads(conversationId!, token!, {
        cursor: pageParam,
        botId,
        status,
        limit: pageSize,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    enabled: enabled && !!conversationId && !!token,
    staleTime: CONVERSATION_THREADS_STALE_MS,
  });

  const threads = useMemo(
    () => dedupeThreads(query.data?.pages.flatMap((page) => page.items) ?? []),
    [query.data],
  );

  const createThread = useCallback(
    async (input: { botId?: string; title?: string; branchFromThreadId?: string | null } = {}) => {
      if (!conversationId || !token) return null;
      const thread = await createConversationThread(conversationId, token, input);
      queryClient.setQueryData<ThreadsInfiniteData>(
        conversationThreadsQueryKey(conversationId, { botId, status, pageSize }),
        (previous) => upsertLoadedThread(previous, thread),
      );
      return thread;
    },
    [botId, conversationId, pageSize, queryClient, status, token],
  );

  const renameThread = useCallback(
    async (threadId: string, title: string) => {
      if (!conversationId || !token) return null;
      const thread = await updateConversationThread(conversationId, token, {
        threadId,
        title,
      });
      queryClient.setQueryData<ThreadsInfiniteData>(
        conversationThreadsQueryKey(conversationId, { botId, status, pageSize }),
        (previous) => updateLoadedThread(previous, thread),
      );
      return thread;
    },
    [botId, conversationId, pageSize, queryClient, status, token],
  );

  const touchThread = useCallback(
    (threadId: string, at = new Date().toISOString()) => {
      if (!conversationId || !token || !enabled) return;
      const previous = queryClient.getQueryData<ThreadsInfiniteData>(queryKey);
      if (!hasLoadedThread(previous, threadId)) {
        void query.refetch();
        return;
      }

      queryClient.setQueryData<ThreadsInfiniteData>(
        queryKey,
        (previous) =>
          updateLoadedThreadActivity(previous, threadId, at),
      );
    },
    [conversationId, enabled, query.refetch, queryClient, queryKey, token],
  );

  useEffect(() => {
    if (!conversationId || !token || !enabled) return;

    const onConversationThreadUpdated = ({
      conversationId: eventConversationId,
      thread,
    }: WsEvents["ws:conversation_thread_updated"]) => {
      if (eventConversationId !== conversationId) return;
      if (botId && thread.botId !== botId) return;
      if (status && thread.status !== status) return;

      const previous = queryClient.getQueryData<ThreadsInfiniteData>(queryKey);
      if (!hasLoadedThread(previous, thread.id)) {
        void query.refetch();
        return;
      }

      queryClient.setQueryData<ThreadsInfiniteData>(
        queryKey,
        (previous) => updateLoadedThread(previous, thread),
      );
    };

    wsEvents.on("ws:conversation_thread_updated", onConversationThreadUpdated);
    return () => {
      wsEvents.off("ws:conversation_thread_updated", onConversationThreadUpdated);
    };
  }, [botId, conversationId, enabled, query.refetch, queryClient, queryKey, status, token]);

  return useMemo(
    () => ({
      threads,
      loading: query.isLoading,
      loadingMore: query.isFetchingNextPage,
      hasMore: query.hasNextPage,
      loadMore: query.fetchNextPage,
      createThread,
      renameThread,
      touchThread,
      refetchThreads: query.refetch,
    }),
    [
      createThread,
      query.fetchNextPage,
      query.hasNextPage,
      query.isFetchingNextPage,
      query.isLoading,
      query.refetch,
      renameThread,
      threads,
      touchThread,
    ],
  );
}

function dedupeThreads(threads: ConversationThreadPublic[]) {
  const seen = new Set<string>();
  return threads.filter((thread) => {
    if (seen.has(thread.id)) return false;
    seen.add(thread.id);
    return true;
  });
}

function hasLoadedThread(
  data: ThreadsInfiniteData | undefined,
  threadId: string,
) {
  return data?.pages.some((page) =>
    page.items.some((thread) => thread.id === threadId),
  ) ?? false;
}

function emptyThreadPages(thread: ConversationThreadPublic): ThreadsInfiniteData {
  return {
    pages: [{ items: [thread], nextCursor: null, hasMore: false }],
    pageParams: [null],
  };
}

function upsertLoadedThread(
  data: ThreadsInfiniteData | undefined,
  thread: ConversationThreadPublic,
): ThreadsInfiniteData {
  if (!data) return emptyThreadPages(thread);
  const [firstPage, ...restPages] = data.pages;
  if (!firstPage) return emptyThreadPages(thread);
  return {
    ...data,
    pages: [
      {
        ...firstPage,
        items: [thread, ...firstPage.items.filter((item) => item.id !== thread.id)],
      },
      ...restPages.map((page) => ({
        ...page,
        items: page.items.filter((item) => item.id !== thread.id),
      })),
    ],
  };
}

function updateLoadedThread(
  data: ThreadsInfiniteData | undefined,
  thread: ConversationThreadPublic,
): ThreadsInfiniteData | undefined {
  if (!data) return data;
  return {
    ...data,
    pages: data.pages.map((page) => ({
      ...page,
      items: page.items.map((item) => (item.id === thread.id ? thread : item)),
    })),
  };
}

function updateLoadedThreadActivity(
  data: ThreadsInfiniteData | undefined,
  threadId: string,
  at: string,
): ThreadsInfiniteData | undefined {
  if (!data) return data;
  const loadedThreads = dedupeThreads(
    data.pages.flatMap((page) =>
      page.items.map((thread) =>
        thread.id === threadId
          ? { ...thread, lastActivityAt: at, updatedAt: at }
          : thread,
      ),
    ),
  ).sort((a, b) => {
    const activity = Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt);
    return activity || b.id.localeCompare(a.id);
  });

  let cursor = 0;
  return {
    ...data,
    pages: data.pages.map((page) => {
      const size = page.items.length;
      const items = loadedThreads.slice(cursor, cursor + size);
      cursor += size;
      return { ...page, items };
    }),
  };
}


