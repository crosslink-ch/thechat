import type {
  BotInvocationPublic,
  BotInvocationProgressEventPublic,
  BotRuntimeSnapshot,
  BotSessionPublic,
} from "@thechat/shared";

const MAX_PROGRESS_EVENTS_PER_INVOCATION = 100;

export function mergeRuntimeUpdate(
  prev: BotRuntimeSnapshot | null,
  session: BotSessionPublic | null,
  invocation: BotInvocationPublic,
): BotRuntimeSnapshot {
  const snapshot = prev ?? { sessions: [], invocations: [], events: [] };
  const isActive = isActiveInvocation(invocation);
  const invocations = isActive
    ? upsertById(snapshot.invocations, invocation)
    : snapshot.invocations.filter((existing) => existing.id !== invocation.id);
  const events = isActive
    ? snapshot.events
    : snapshot.events.filter((event) => event.invocationId !== invocation.id);
  return {
    sessions: session ? upsertById(snapshot.sessions, session) : snapshot.sessions,
    invocations,
    events: pruneProgressEvents(events),
  };
}

export function mergeRuntimeProgressEvent(
  prev: BotRuntimeSnapshot | null,
  event: BotInvocationProgressEventPublic,
): BotRuntimeSnapshot {
  const snapshot = prev ?? { sessions: [], invocations: [], events: [] };
  return {
    sessions: snapshot.sessions,
    invocations: snapshot.invocations,
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

function isActiveInvocation(invocation: BotInvocationPublic) {
  return invocation.status === "queued" || invocation.status === "running";
}
