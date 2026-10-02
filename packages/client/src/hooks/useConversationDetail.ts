import { isAuthenticated } from "../lib/auth-identity";
import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ConversationDetail } from "@thechat/shared";
import { api } from "../lib/api";
import { authHeaders, edenErrorMessage } from "../lib/eden";
import { botAvatarsOf } from "../lib/bot-appearance";
import { useWorkspacesStore } from "../stores/workspaces";

const CONVERSATION_DETAIL_STALE_MS = 5 * 60_000;

export const conversationDetailQueryKey = (conversationId: string) =>
  ["conversation-detail", conversationId] as const;

export async function fetchConversationDetail(
  conversationId: string,
  token: string | null,
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
  const client = useQueryClient();
  const members = useWorkspacesStore((state) => state.activeWorkspace?.members);
  const query = useQuery({
    queryKey: conversationId
      ? conversationDetailQueryKey(conversationId)
      : ["conversation-detail", "disabled"],
    queryFn: () => fetchConversationDetail(conversationId!, token!),
    enabled: !!conversationId && isAuthenticated(token),
    staleTime: CONVERSATION_DETAIL_STALE_MS,
  });

  // Preserve observed live appearance updates in the displayed conversation's
  // identity. An unrelated sidebar workspace must not reset that bot's style.
  useEffect(() => {
    if (!conversationId || !isAuthenticated(token) || !query.data || !members) return;
    const avatars = botAvatarsOf(members);
    if (avatars.size === 0) return;
    client.setQueryData<ConversationDetail>(conversationDetailQueryKey(conversationId), (current) => {
      if (!current) return current;
      let changed = false;
      const participants = current.participants.map((participant) => {
        const avatar = avatars.get(participant.userId);
        if (!participant.bot || !avatar || (
          participant.bot.avatar?.shape === avatar.shape &&
          participant.bot.avatar?.color === avatar.color
        )) return participant;
        changed = true;
        return { ...participant, bot: { ...participant.bot, avatar } };
      });
      return changed ? { ...current, participants } : current;
    });
  }, [client, conversationId, members, query.data, token]);

  return query;
}
