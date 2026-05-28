import { useCallback, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ConversationThreadPublic } from "@thechat/shared";
import { api } from "../lib/api";
import { authHeaders, edenErrorMessage } from "../lib/eden";

const CONVERSATION_THREADS_STALE_MS = 60_000;

export const conversationThreadsQueryKey = (conversationId: string) =>
  ["conversation-threads", conversationId] as const;

async function fetchConversationThreads(
  conversationId: string,
  token: string,
): Promise<ConversationThreadPublic[]> {
  const { data, error } = await api.conversations.threads({ conversationId }).get(
    authHeaders(token),
  );

  if (error) {
    throw new Error(edenErrorMessage(error, "Failed to load task threads"));
  }

  return Array.isArray(data) ? (data as ConversationThreadPublic[]) : [];
}

async function createConversationThread(
  conversationId: string,
  token: string,
  input: { botId?: string; title?: string },
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
) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: conversationId
      ? conversationThreadsQueryKey(conversationId)
      : ["conversation-threads", "disabled"],
    queryFn: () => fetchConversationThreads(conversationId!, token!),
    enabled: enabled && !!conversationId && !!token,
    staleTime: CONVERSATION_THREADS_STALE_MS,
  });

  const createThread = useCallback(
    async (input: { botId?: string; title?: string } = {}) => {
      if (!conversationId || !token) return null;
      const thread = await createConversationThread(conversationId, token, input);
      queryClient.setQueryData<ConversationThreadPublic[]>(
        conversationThreadsQueryKey(conversationId),
        (previous = []) => [thread, ...previous.filter((item) => item.id !== thread.id)],
      );
      return thread;
    },
    [conversationId, queryClient, token],
  );

  const renameThread = useCallback(
    async (threadId: string, title: string) => {
      if (!conversationId || !token) return null;
      const thread = await updateConversationThread(conversationId, token, {
        threadId,
        title,
      });
      queryClient.setQueryData<ConversationThreadPublic[]>(
        conversationThreadsQueryKey(conversationId),
        (previous = []) =>
          previous.map((item) => (item.id === thread.id ? thread : item)),
      );
      return thread;
    },
    [conversationId, queryClient, token],
  );

  const touchThread = useCallback(
    (threadId: string, at = new Date().toISOString()) => {
      if (!conversationId) return;
      queryClient.setQueryData<ConversationThreadPublic[]>(
        conversationThreadsQueryKey(conversationId),
        (previous = []) =>
          previous
            .map((thread) =>
              thread.id === threadId
                ? { ...thread, lastActivityAt: at, updatedAt: at }
                : thread,
            )
            .sort((a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt)),
      );
    },
    [conversationId, queryClient],
  );

  return useMemo(
    () => ({
      threads: query.data ?? [],
      loading: query.isLoading,
      createThread,
      renameThread,
      touchThread,
      refetchThreads: query.refetch,
    }),
    [createThread, query.data, query.isLoading, query.refetch, renameThread, touchThread],
  );
}
