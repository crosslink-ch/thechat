import { isAuthenticated } from "../lib/auth-identity";
import { backgroundTaskTerminal } from "@thechat/shared";
import { useCallback, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  BotInvocationProgressEventPublic,
  BotInvocationPublic,
  BotRuntimeSnapshot,
  VaultUnlockResponse,
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
  token: string | null,
): Promise<BotRuntimeSnapshot> {
  const { data, error } = await api["bot-runtime"]
    .conversations({ conversationId })
    .get(authHeaders(token));

  if (error) {
    throw new Error(edenErrorMessage(error, "Failed to load bot runtime"));
  }

  return data as BotRuntimeSnapshot;
}

export async function submitHermesInteraction(
  invocationId: string,
  eventId: string,
  response: string | string[],
  token: string | null,
): Promise<void> {
  const { error } = await api["bot-runtime"]
    .invocations({ invocationId })
    .interactions({ eventId })
    .post({ response }, authHeaders(token));
  if (error) {
    throw new Error(
      edenErrorMessage(error, "Failed to deliver the Hermes response"),
    );
  }
}

export async function submitHermesVaultUnlock(invocationId: string, eventId: string, response: VaultUnlockResponse, token: string | null): Promise<void> {
  try {
    const {data,error} = await api["bot-runtime"].invocations({invocationId}).interactions({eventId})["vault-unlock"].post(response,authHeaders(token));
    if (error || !data || !("ok" in data) || data.ok !== true) throw new Error();
  } catch { throw new Error("Could not deliver the vault unlock response"); }
}

export async function submitBackgroundTaskStop(task: {botId:string;taskId:string}, token: string | null): Promise<void> {
  try {
    const {data,error} = await api["bot-runtime"].bots({botId:task.botId}).activity({taskId:task.taskId}).stop.post({},authHeaders(token));
    if (error || !data || !("ok" in data) || data.ok !== true || !("taskId" in data) || data.taskId !== task.taskId || !("state" in data) || data.state !== "requested") throw new Error();
  } catch { throw new Error("Could not request task stop"); }
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
    structuralSharing: (oldData, newData) => {
      const previous = oldData as BotRuntimeSnapshot | undefined;
      const next = newData as BotRuntimeSnapshot;
      if (!next.activity || !previous?.activity) return next;
      const current = new Map(previous.activity.map(task => [`${task.botId}:${task.taskId}`, task]));
      return { ...next, activity: next.activity.map(task => {
        const newer = current.get(`${task.botId}:${task.taskId}`);
        return newer && newer.sequence > task.sequence ? newer : task;
      }) };
    },
    enabled: enabled && !!conversationId && isAuthenticated(token),
    staleTime: BOT_RUNTIME_STALE_MS,
    refetchInterval: (query) =>
      hasActiveBotRuntimeActivity(query.state.data as BotRuntimeSnapshot | undefined)
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
      invocation?: BotInvocationPublic,
    ) => {
      queryClient.setQueryData<BotRuntimeSnapshot>(
        botRuntimeQueryKey(conversationId),
        (previous) => mergeRuntimeProgressEvent(previous ?? null, event, invocation),
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

export function hasActiveBotRuntimeActivity(snapshot: BotRuntimeSnapshot | undefined) {
  return (
    snapshot?.invocations.some(
      (invocation) =>
        invocation.status === "queued" ||
        (invocation.botKind !== "hermes" && invocation.status === "running"),
    ) || (snapshot?.events.length ?? 0) > 0 || (snapshot?.activity?.some(task => !backgroundTaskTerminal(task.parent.state)) ?? false)
  );
}
