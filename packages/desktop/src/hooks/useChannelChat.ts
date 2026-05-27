import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ChatMessage } from "@thechat/shared";
import { api } from "../lib/api";
import { authHeaders, edenErrorMessage } from "../lib/eden";

const MESSAGE_CACHE_TTL_MS = 60_000;

interface UseChannelChatOptions {
  conversationId: string | null;
  threadId?: string | null;
  token: string | null;
  wsSendMessage: (conversationId: string, content: string, threadId?: string | null) => void;
}

export const messagesQueryKey = (conversationId: string, threadId?: string | null) =>
  ["messages", conversationId, threadId ?? "all"] as const;

async function fetchMessages(
  conversationId: string,
  token: string,
  threadId?: string | null,
): Promise<ChatMessage[]> {
  const { data, error } = await api.messages({ conversationId }).get({
    query: threadId ? { limit: 50, threadId } : { limit: 50 },
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
  token,
  wsSendMessage,
}: UseChannelChatOptions) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: conversationId
      ? messagesQueryKey(conversationId, threadId)
      : ["messages", "disabled"],
    queryFn: () => fetchMessages(conversationId!, token!, threadId),
    enabled: !!conversationId && !!token,
    staleTime: MESSAGE_CACHE_TTL_MS,
  });

  const addMessage = useCallback(
    (msg: ChatMessage) => {
      if (msg.conversationId !== conversationId) return;
      if (threadId && msg.threadId !== threadId) return;
      queryClient.setQueryData<ChatMessage[]>(
        messagesQueryKey(conversationId, threadId),
        (prev = []) => {
          if (prev.some((m) => m.id === msg.id)) return prev;
          return [...prev, msg];
        },
      );
    },
    [conversationId, queryClient, threadId],
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
