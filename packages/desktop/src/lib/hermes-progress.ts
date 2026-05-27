import type {
  BotInvocationPublic,
  BotInvocationProgressEventPublic,
  BotRuntimeSnapshot,
} from "@thechat/shared";

export interface ActiveHermesProgress {
  invocations: BotInvocationPublic[];
  events: BotInvocationProgressEventPublic[];
  typingSuppressedUserIds: string[];
}

export function selectHermesConversationProgress(
  runtime: BotRuntimeSnapshot | null,
  threadId?: string | null,
): ActiveHermesProgress {
  return selectActiveHermesProgress(runtime, threadId);
}

function selectActiveHermesProgress(
  runtime: BotRuntimeSnapshot | null,
  threadId?: string | null,
): ActiveHermesProgress {
  const activeInvocations = (runtime?.invocations ?? []).filter(
    (invocation) =>
      invocation.botKind === "hermes" &&
      (!threadId || invocation.threadId === threadId) &&
      (invocation.status === "queued" || invocation.status === "running"),
  );
  const visibleInvocationIds = new Set(
    activeInvocations.map((invocation) => invocation.id),
  );

  return {
    invocations: activeInvocations,
    events: (runtime?.events ?? []).filter((event) =>
      visibleInvocationIds.has(event.invocationId),
    ),
    typingSuppressedUserIds: Array.from(
      new Set(activeInvocations.map((invocation) => invocation.botUserId)),
    ),
  };
}
