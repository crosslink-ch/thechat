import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ChatMessage } from "@thechat/shared";
import { api } from "../lib/api";
import { authHeaders, edenErrorMessage } from "../lib/eden";

const MESSAGE_CACHE_TTL_MS = 60_000;

interface UseChannelChatOptions {
  conversationId: string | null;
  token: string | null;
  botSessionId?: string | null;
  wsSendMessage: (conversationId: string, content: string, botSessionId?: string | null) => void;
}

export const messagesQueryKey = (
  conversationId: string,
  botSessionId: string | null | undefined,
) => ["messages", conversationId, botSessionId ?? "all"] as const;

async function fetchMessages(
  conversationId: string,
  token: string,
  botSessionId: string | null | undefined,
): Promise<ChatMessage[]> {
  const { data, error } = await api.messages({ conversationId }).get({
    query: { limit: 50, botSessionId: botSessionId ?? undefined },
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
  botSessionId,
  wsSendMessage,
}: UseChannelChatOptions) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: conversationId
      ? messagesQueryKey(conversationId, botSessionId)
      : ["messages", "disabled"],
    queryFn: () => fetchMessages(conversationId!, token!, botSessionId),
    enabled: !!conversationId && !!token,
    staleTime: MESSAGE_CACHE_TTL_MS,
  });

  const addMessage = useCallback(
    (msg: ChatMessage) => {
      if (msg.conversationId !== conversationId) return;
      if (botSessionId !== undefined && msg.botSessionId !== botSessionId) return;
      queryClient.setQueryData<ChatMessage[]>(
        messagesQueryKey(conversationId, botSessionId),
        (prev = []) => {
          if (prev.some((m) => m.id === msg.id)) return prev;
          return [...prev, msg];
        },
      );
    },
    [botSessionId, conversationId, queryClient],
  );

  const sendMessage = useCallback(
    (content: string) => {
      if (!conversationId) return;
      wsSendMessage(conversationId, content, botSessionId);
    },
    [botSessionId, conversationId, wsSendMessage],
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
