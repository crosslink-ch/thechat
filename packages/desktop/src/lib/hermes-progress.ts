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
): ActiveHermesProgress {
  return selectActiveHermesProgress(runtime);
}

export function selectHermesSessionProgress(
  runtime: BotRuntimeSnapshot | null,
  sessionId: string | null | undefined,
): ActiveHermesProgress {
  return selectActiveHermesProgress(runtime, sessionId);
}

function selectActiveHermesProgress(
  runtime: BotRuntimeSnapshot | null,
  sessionId?: string | null,
): ActiveHermesProgress {
  const activeInvocations = (runtime?.invocations ?? []).filter(
    (invocation) =>
      invocation.botKind === "hermes" &&
      (invocation.status === "queued" || invocation.status === "running"),
  );
  const visibleInvocations = sessionId !== undefined
    ? activeInvocations.filter(
        (invocation) => !!sessionId && invocation.botSessionId === sessionId,
      )
    : activeInvocations;
  const visibleInvocationIds = new Set(
    visibleInvocations.map((invocation) => invocation.id),
  );

  return {
    invocations: visibleInvocations,
    events: (runtime?.events ?? []).filter((event) =>
      visibleInvocationIds.has(event.invocationId),
    ),
    typingSuppressedUserIds: Array.from(
      new Set(activeInvocations.map((invocation) => invocation.botUserId)),
    ),
  };
}
