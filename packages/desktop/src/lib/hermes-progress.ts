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
  options: { unthreadedOnly?: boolean } = {},
): ActiveHermesProgress {
  return selectActiveHermesProgress(runtime, threadId, options);
}

function selectActiveHermesProgress(
  runtime: BotRuntimeSnapshot | null,
  threadId?: string | null,
  options: { unthreadedOnly?: boolean } = {},
): ActiveHermesProgress {
  const activeInvocations = (runtime?.invocations ?? []).filter(
    (invocation) =>
      invocation.botKind === "hermes" &&
      matchesThreadScope(invocation.threadId, threadId, options.unthreadedOnly === true) &&
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

function matchesThreadScope(
  invocationThreadId: string | null,
  selectedThreadId: string | null | undefined,
  unthreadedOnly: boolean,
) {
  if (unthreadedOnly) return invocationThreadId === null;
  if (selectedThreadId) return invocationThreadId === selectedThreadId;
  return true;
}
