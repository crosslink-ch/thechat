import type {
  BotInvocationPublic,
  BotInvocationProgressEventPublic,
  BotRuntimeSnapshot,
} from "@thechat/shared";

export interface ActiveHermesProgress {
  invocations: ActiveHermesInvocationProgress[];
  typingSuppressedUserIds: string[];
}

export interface ActiveHermesInvocationProgress {
  invocation: BotInvocationPublic;
  events: BotInvocationProgressEventPublic[];
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
  const eventsByInvocationId = new Map<string, BotInvocationProgressEventPublic[]>();
  for (const event of runtime?.events ?? []) {
    if (!visibleInvocationIds.has(event.invocationId)) continue;
    const invocationEvents = eventsByInvocationId.get(event.invocationId) ?? [];
    invocationEvents.push(event);
    eventsByInvocationId.set(event.invocationId, invocationEvents);
  }

  return {
    invocations: activeInvocations.map((invocation) => ({
      invocation,
      events: eventsByInvocationId.get(invocation.id) ?? [],
    })),
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
