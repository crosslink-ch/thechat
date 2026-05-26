import { useCallback, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  BotInvocationProgressEventPublic,
  BotInvocationPublic,
  BotRuntimeSnapshot,
  BotSessionPublic,
} from "@thechat/shared";
import { api } from "../lib/api";
import { authHeaders, edenErrorMessage } from "../lib/eden";
import {
  mergeRuntimeProgressEvent,
  mergeRuntimeUpdate,
} from "../lib/bot-runtime-state";

const BOT_RUNTIME_STALE_MS = 60_000;

export const botRuntimeQueryKey = (conversationId: string) =>
  ["bot-runtime", conversationId] as const;

export async function fetchBotRuntime(
  conversationId: string,
  token: string,
): Promise<BotRuntimeSnapshot> {
  const { data, error } = await api["bot-runtime"]
    .conversations({ conversationId })
    .get(authHeaders(token));

  if (error) {
    throw new Error(edenErrorMessage(error, "Failed to load bot runtime"));
  }

  return data as BotRuntimeSnapshot;
}

export async function createHermesBotSession(
  conversationId: string,
  token: string,
  botId?: string | null,
): Promise<BotSessionPublic> {
  const { data, error } = await api["bot-runtime"]
    .conversations({ conversationId })
    .sessions
    .post({ botId: botId ?? undefined }, authHeaders(token));

  if (error) {
    throw new Error(edenErrorMessage(error, "Failed to create Hermes session"));
  }

  return data as BotSessionPublic;
}

export function useBotRuntime(
  conversationId: string | null,
  token: string | null,
  enabled = true,
) {
  return useQuery({
    queryKey: conversationId
      ? botRuntimeQueryKey(conversationId)
      : ["bot-runtime", "disabled"],
    queryFn: () => fetchBotRuntime(conversationId!, token!),
    enabled: enabled && !!conversationId && !!token,
    staleTime: BOT_RUNTIME_STALE_MS,
  });
}

export function useCreateHermesBotSession(
  conversationId: string,
  token: string | null,
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ botId }: { botId?: string | null } = {}) => {
      if (!token) throw new Error("Authentication required");
      return createHermesBotSession(conversationId, token, botId);
    },
    onSuccess: (session) => {
      queryClient.setQueryData<BotRuntimeSnapshot>(
        botRuntimeQueryKey(conversationId),
        (previous) => ({
          sessions: [
            session,
            ...(previous?.sessions ?? []).filter(
              (existing) => existing.id !== session.id,
            ),
          ],
          invocations: previous?.invocations ?? [],
          events: previous?.events ?? [],
        }),
      );
    },
  });
}

export function useBotRuntimeCache() {
  const queryClient = useQueryClient();

  const mergeInvocationUpdate = useCallback(
    (
      conversationId: string,
      session: BotSessionPublic | null,
      invocation: BotInvocationPublic,
    ) => {
      queryClient.setQueryData<BotRuntimeSnapshot>(
        botRuntimeQueryKey(conversationId),
        (previous) => mergeRuntimeUpdate(previous ?? null, session, invocation),
      );
    },
    [queryClient],
  );

  const mergeProgressEvent = useCallback(
    (
      conversationId: string,
      event: BotInvocationProgressEventPublic,
    ) => {
      queryClient.setQueryData<BotRuntimeSnapshot>(
        botRuntimeQueryKey(conversationId),
        (previous) => mergeRuntimeProgressEvent(previous ?? null, event),
      );
    },
    [queryClient],
  );

  const invalidate = useCallback(
    (conversationId: string) => {
      void queryClient.invalidateQueries({
        queryKey: botRuntimeQueryKey(conversationId),
      });
    },
    [queryClient],
  );

  return useMemo(
    () => ({ mergeInvocationUpdate, mergeProgressEvent, invalidate }),
    [invalidate, mergeInvocationUpdate, mergeProgressEvent],
  );
}
