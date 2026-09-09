import type {
  BotInvocationPublic,
  BotInvocationProgressEventPublic,
  BotRuntimeSnapshot,
} from "@thechat/shared";

const MAX_PROGRESS_EVENTS_PER_INVOCATION = 100;

export function mergeRuntimeUpdate(
  prev: BotRuntimeSnapshot | null,
  invocation: BotInvocationPublic,
): BotRuntimeSnapshot {
  const snapshot = prev ?? { invocations: [], events: [] };
  if (
    snapshot.events.some(
      (event) =>
        event.invocationId === invocation.id &&
        isTerminalHermesProgressEvent(event),
    )
  ) {
    return snapshot;
  }
  const isDurablyActive =
    invocation.status === "queued" ||
    (invocation.botKind !== "hermes" && invocation.status === "running");
  const isActive =
    !isLegacyTerminalInvocation(invocation) &&
    (isDurablyActive ||
      snapshot.events.some((event) => event.invocationId === invocation.id));
  const invocations = isActive
    ? upsertById(snapshot.invocations, invocation)
    : snapshot.invocations.filter((existing) => existing.id !== invocation.id);
  const events = isActive
    ? snapshot.events
    : snapshot.events.filter((event) => event.invocationId !== invocation.id);
  return {
    invocations,
    events: pruneProgressEvents(events),
  };
}

export function mergeRuntimeProgressEvent(
  prev: BotRuntimeSnapshot | null,
  event: BotInvocationProgressEventPublic,
  invocation?: BotInvocationPublic,
): BotRuntimeSnapshot {
  const snapshot = prev ?? { invocations: [], events: [] };
  const terminalSequence = snapshot.events.reduce((latest, existing) =>
    existing.invocationId === event.invocationId &&
    isTerminalHermesProgressEvent(existing)
      ? Math.max(latest, existing.sequence)
      : latest,
  Number.NEGATIVE_INFINITY);
  if (
    isTerminalHermesProgressEvent(event) &&
    terminalSequence >= event.sequence
  ) {
    return {
      invocations: snapshot.invocations.filter(
        (existing) => existing.id !== event.invocationId,
      ),
      events: snapshot.events,
    };
  }
  if (!isTerminalHermesProgressEvent(event) && terminalSequence >= event.sequence) {
    return snapshot;
  }
  if (isTerminalHermesProgressEvent(event)) {
    return {
      invocations: snapshot.invocations.filter(
        (existing) => existing.id !== event.invocationId,
      ),
      events: pruneProgressEvents([
        ...snapshot.events.filter(
          (existing) => existing.invocationId !== event.invocationId,
        ),
        event,
      ]),
    };
  }
  return {
    invocations: invocation
      ? upsertById(snapshot.invocations, invocation)
      : snapshot.invocations,
    events: pruneProgressEvents(
      upsertById(snapshot.events, event),
    ),
  };
}

function upsertById<T extends { id: string }>(items: T[], item: T) {
  const next = items.filter((existing) => existing.id !== item.id);
  next.unshift(item);
  return next;
}

function compareProgressEvents(
  a: BotInvocationProgressEventPublic,
  b: BotInvocationProgressEventPublic,
) {
  const byInvocation = a.invocationId.localeCompare(b.invocationId);
  if (byInvocation !== 0) return byInvocation;
  if (a.sequence !== b.sequence) return a.sequence - b.sequence;
  return Date.parse(a.createdAt) - Date.parse(b.createdAt);
}

function pruneProgressEvents(events: BotInvocationProgressEventPublic[]) {
  const sorted = [...events].sort(compareProgressEvents);
  const counts = new Map<string, number>();
  const kept: BotInvocationProgressEventPublic[] = [];

  for (let index = sorted.length - 1; index >= 0; index -= 1) {
    const event = sorted[index];
    const count = counts.get(event.invocationId) ?? 0;
    if (count >= MAX_PROGRESS_EVENTS_PER_INVOCATION) continue;
    counts.set(event.invocationId, count + 1);
    kept.push(event);
  }

  return kept.reverse();
}

export function isTerminalHermesProgressEvent(
  event: BotInvocationProgressEventPublic,
) {
  return (
    event.type === "invocation.completed" ||
    event.type === "invocation.failed" ||
    event.type === "invocation.cancelled"
  );
}

function isLegacyTerminalInvocation(invocation: BotInvocationPublic) {
  return (
    invocation.status === "completed" ||
    invocation.status === "failed" ||
    invocation.status === "cancelled"
  );
}
