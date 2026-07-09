import { useCallback, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  BotInvocationProgressEventPublic,
  BotInvocationPublic,
  BotRuntimeSnapshot,
} from "@thechat/shared";
import { api } from "../lib/api";
import { authHeaders, edenErrorMessage } from "../lib/eden";
import {
  mergeRuntimeProgressEvent,
  mergeRuntimeUpdate,
} from "../lib/bot-runtime-state";

const BOT_RUNTIME_STALE_MS = 60_000;
const BOT_RUNTIME_ACTIVE_REFETCH_MS = 15_000;

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
    refetchInterval: (query) =>
      hasActiveInvocation(query.state.data as BotRuntimeSnapshot | undefined)
        ? BOT_RUNTIME_ACTIVE_REFETCH_MS
        : false,
  });
}

export function useBotRuntimeCache() {
  const queryClient = useQueryClient();

  const mergeInvocationUpdate = useCallback(
    (
      conversationId: string,
      invocation: BotInvocationPublic,
    ) => {
      queryClient.setQueryData<BotRuntimeSnapshot>(
        botRuntimeQueryKey(conversationId),
        (previous) => mergeRuntimeUpdate(previous ?? null, invocation),
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

function hasActiveInvocation(snapshot: BotRuntimeSnapshot | undefined) {
  return (
    snapshot?.invocations.some(
      (invocation) =>
        invocation.status === "queued" || invocation.status === "running",
    ) ?? false
  );
}
