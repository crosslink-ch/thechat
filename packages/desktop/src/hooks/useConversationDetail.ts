import { useQuery } from "@tanstack/react-query";
import type { ConversationDetail } from "@thechat/shared";
import { api } from "../lib/api";
import { authHeaders, edenErrorMessage } from "../lib/eden";

const CONVERSATION_DETAIL_STALE_MS = 5 * 60_000;

export const conversationDetailQueryKey = (conversationId: string) =>
  ["conversation-detail", conversationId] as const;

export async function fetchConversationDetail(
  conversationId: string,
  token: string,
): Promise<ConversationDetail> {
  const { data, error } = await api.conversations
    .detail({ conversationId })
    .get(authHeaders(token));

  if (error) {
    throw new Error(edenErrorMessage(error, "Failed to load conversation"));
  }

  return data as ConversationDetail;
}

export function useConversationDetail(
  conversationId: string | null,
  token: string | null,
) {
  return useQuery({
    queryKey: conversationId
      ? conversationDetailQueryKey(conversationId)
      : ["conversation-detail", "disabled"],
    queryFn: () => fetchConversationDetail(conversationId!, token!),
    enabled: !!conversationId && !!token,
    staleTime: CONVERSATION_DETAIL_STALE_MS,
  });
}
