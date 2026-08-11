import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ConversationThreadPublic,
  HermesRpcSessionPublic,
  HermesRpcSessionsResponse,
} from "@thechat/shared";
import { api } from "../lib/api";
import { authHeaders, edenErrorMessage } from "../lib/eden";

export const hermesRpcSessionsQueryKey = (botId: string, conversationId: string) =>
  ["hermes-rpc-sessions", botId, conversationId] as const;

export function useHermesRpcSessions(input: {
  botId: string | null;
  conversationId: string;
  token: string | null;
  enabled: boolean;
}) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: input.botId
      ? hermesRpcSessionsQueryKey(input.botId, input.conversationId)
      : ["hermes-rpc-sessions", "disabled"],
    enabled: input.enabled && !!input.botId && !!input.token,
    queryFn: async () => {
      const { data, error } = await api
        .bots({ botId: input.botId! })["hermes-rpc"]
        .sessions.get({
          query: { conversationId: input.conversationId },
          ...authHeaders(input.token!),
        });
      if (error) throw new Error(edenErrorMessage(error, "Hermes sessions are unavailable"));
      return data as HermesRpcSessionsResponse;
    },
    staleTime: 15_000,
  });

  const selectSession = useCallback(async (upstreamSessionId: string) => {
    if (!input.botId || !input.token) return null;
    const { data, error } = await api
      .bots({ botId: input.botId })["hermes-rpc"]
      .sessions.select.post(
        {
          conversationId: input.conversationId,
          upstreamSessionId,
        },
        authHeaders(input.token),
      );
    if (error) throw new Error(edenErrorMessage(error, "Hermes session could not be selected"));
    const selected = data as {
      session: HermesRpcSessionPublic;
      thread: ConversationThreadPublic | null;
    };
    queryClient.setQueryData<HermesRpcSessionsResponse>(
      hermesRpcSessionsQueryKey(input.botId, input.conversationId),
      (previous) => ({
        sessions: (previous?.sessions ?? []).map((session) =>
          session.id === selected.session.id ? selected.session : session),
      }),
    );
    return selected;
  }, [input.botId, input.conversationId, input.token, queryClient]);

  return {
    sessions: query.data?.sessions ?? [],
    loading: query.isLoading,
    refreshing: query.isFetching,
    error: query.error instanceof Error ? query.error.message : null,
    refetch: query.refetch,
    selectSession,
  };
}
