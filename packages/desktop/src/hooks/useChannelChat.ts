import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ChatMessage } from "@thechat/shared";
import { api } from "../lib/api";
import { authHeaders, edenErrorMessage } from "../lib/eden";

const MESSAGE_CACHE_TTL_MS = 60_000;

interface UseChannelChatOptions {
  conversationId: string | null;
  token: string | null;
  wsSendMessage: (conversationId: string, content: string) => void;
}

export const messagesQueryKey = (conversationId: string) =>
  ["messages", conversationId] as const;

async function fetchMessages(
  conversationId: string,
  token: string,
): Promise<ChatMessage[]> {
  const { data, error } = await api.messages({ conversationId }).get({
    query: { limit: 50 },
    ...authHeaders(token),
  });

  if (error) {
    throw new Error(edenErrorMessage(error, "Failed to load messages"));
  }

  return Array.isArray(data) ? (data as ChatMessage[]) : [];
}

export function useChannelChat({
  conversationId,
  token,
  wsSendMessage,
}: UseChannelChatOptions) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: conversationId
      ? messagesQueryKey(conversationId)
      : ["messages", "disabled"],
    queryFn: () => fetchMessages(conversationId!, token!),
    enabled: !!conversationId && !!token,
    staleTime: MESSAGE_CACHE_TTL_MS,
  });

  const addMessage = useCallback(
    (msg: ChatMessage) => {
      if (msg.conversationId !== conversationId) return;
      queryClient.setQueryData<ChatMessage[]>(
        messagesQueryKey(conversationId),
        (prev = []) => {
          if (prev.some((m) => m.id === msg.id)) return prev;
          return [...prev, msg];
        },
      );
    },
    [conversationId, queryClient],
  );

  const sendMessage = useCallback(
    (content: string) => {
      if (!conversationId) return;
      wsSendMessage(conversationId, content);
    },
    [conversationId, wsSendMessage],
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
