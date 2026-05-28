import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ChatMessage } from "@thechat/shared";
import { api } from "../lib/api";
import { authHeaders, edenErrorMessage } from "../lib/eden";

const MESSAGE_CACHE_TTL_MS = 60_000;

interface UseChannelChatOptions {
  conversationId: string | null;
  threadId?: string | null;
  unthreadedOnly?: boolean;
  token: string | null;
  wsSendMessage: (conversationId: string, content: string, threadId?: string | null) => void;
}

export const messagesQueryKey = (
  conversationId: string,
  threadId?: string | null,
  unthreadedOnly = false,
) => ["messages", conversationId, unthreadedOnly ? "general" : threadId ?? "all"] as const;

async function fetchMessages(
  conversationId: string,
  token: string,
  threadId?: string | null,
  unthreadedOnly = false,
): Promise<ChatMessage[]> {
  const query: Record<string, string | number> = { limit: 50 };
  if (threadId) {
    query.threadId = threadId;
  } else if (unthreadedOnly) {
    query.unthreaded = "true";
  }

  const { data, error } = await api.messages({ conversationId }).get({
    query,
    ...authHeaders(token),
  });

  if (error) {
    throw new Error(edenErrorMessage(error, "Failed to load messages"));
  }

  return Array.isArray(data) ? (data as ChatMessage[]) : [];
}

export function useChannelChat({
  conversationId,
  threadId = null,
  unthreadedOnly = false,
  token,
  wsSendMessage,
}: UseChannelChatOptions) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: conversationId
      ? messagesQueryKey(conversationId, threadId, unthreadedOnly)
      : ["messages", "disabled"],
    queryFn: () => fetchMessages(conversationId!, token!, threadId, unthreadedOnly),
    enabled: !!conversationId && !!token,
    staleTime: MESSAGE_CACHE_TTL_MS,
  });

  const addMessage = useCallback(
    (msg: ChatMessage) => {
      if (msg.conversationId !== conversationId) return;

      const updateCache = (
        cacheThreadId: string | null,
        cacheUnthreadedOnly: boolean,
        createIfMissing: boolean,
      ) => {
        const key = messagesQueryKey(conversationId, cacheThreadId, cacheUnthreadedOnly);
        if (!createIfMissing && queryClient.getQueryData(key) === undefined) return;
        queryClient.setQueryData<ChatMessage[]>(key, (prev = []) =>
          appendMessage(prev, msg),
        );
      };

      if (msg.threadId) {
        updateCache(msg.threadId, false, !unthreadedOnly && msg.threadId === threadId);
        updateCache(null, false, !unthreadedOnly && threadId === null);
      } else {
        updateCache(null, true, unthreadedOnly && threadId === null);
        updateCache(null, false, !unthreadedOnly && threadId === null);
      }
    },
    [conversationId, queryClient, threadId, unthreadedOnly],
  );

  const sendMessage = useCallback(
    (content: string) => {
      if (!conversationId) return;
      wsSendMessage(conversationId, content, threadId ?? null);
    },
    [conversationId, threadId, wsSendMessage],
  );

  const refetchMessages = useCallback(() => {
    if (!conversationId || !token) return;
    void query.refetch();
  }, [conversationId, query.refetch, token]);

  return {
    messages: query.data ?? [],
    loading: query.isLoading,
    addMessage,
    sendMessage,
    refetchMessages,
  };
}

function appendMessage(messages: ChatMessage[], msg: ChatMessage) {
  if (messages.some((m) => m.id === msg.id)) return messages;
  return [...messages, msg];
}
