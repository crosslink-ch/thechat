import type {
  BotInvocationPublic,
  BotInvocationProgressEventPublic,
  BotRuntimeSnapshot,
} from "@thechat/shared";
import { deriveApprovalStates } from "./hermes-approvals";

export interface ActiveHermesProgress {
  invocations: ActiveHermesInvocationProgress[];
  typingSuppressedUserIds: string[];
}

export interface ActiveHermesInvocationProgress {
  invocation: BotInvocationPublic;
  events: BotInvocationProgressEventPublic[];
}

interface HermesProgressSelectionOptions {
  unthreadedOnly?: boolean;
  activeTypingUserIds?: Iterable<string>;
  nowMs?: number;
  silentRunningGraceMs?: number;
}

const DEFAULT_SILENT_RUNNING_GRACE_MS = 30_000;

export function selectHermesConversationProgress(
  runtime: BotRuntimeSnapshot | null,
  threadId?: string | null,
  options: HermesProgressSelectionOptions = {},
): ActiveHermesProgress {
  return selectActiveHermesProgress(runtime, threadId, options);
}

function selectActiveHermesProgress(
  runtime: BotRuntimeSnapshot | null,
  threadId?: string | null,
  options: HermesProgressSelectionOptions = {},
): ActiveHermesProgress {
  const scopedInvocations = (runtime?.invocations ?? []).filter(
    (invocation) =>
      invocation.botKind === "hermes" &&
      matchesThreadScope(invocation.threadId, threadId, options.unthreadedOnly === true) &&
      (invocation.status === "queued" || invocation.status === "running"),
  );
  const visibleInvocationIds = new Set(
    scopedInvocations.map((invocation) => invocation.id),
  );
  const eventsByInvocationId = new Map<string, BotInvocationProgressEventPublic[]>();
  for (const event of runtime?.events ?? []) {
    if (!visibleInvocationIds.has(event.invocationId)) continue;
    const invocationEvents = eventsByInvocationId.get(event.invocationId) ?? [];
    invocationEvents.push(event);
    eventsByInvocationId.set(event.invocationId, invocationEvents);
  }

  const activeTypingUserIds = new Set(options.activeTypingUserIds ?? []);
  const nowMs = options.nowMs ?? Date.now();
  const silentRunningGraceMs =
    options.silentRunningGraceMs ?? DEFAULT_SILENT_RUNNING_GRACE_MS;
  const visibleInvocations = scopedInvocations.filter((invocation) => {
    if (invocation.status !== "running") return true;
    if ((eventsByInvocationId.get(invocation.id)?.length ?? 0) > 0) return true;
    if (activeTypingUserIds.has(invocation.botUserId)) return true;
    return nowMs - updatedTimestamp(invocation) <= silentRunningGraceMs;
  });

  const invocationsByLane = new Map<string, BotInvocationPublic[]>();
  // Hermes serializes turns within a bot/thread lane. During an interrupt the
  // outgoing and incoming message invocations can overlap briefly, but they
  // represent one visible worker rather than independent progress cards.
  for (const invocation of visibleInvocations) {
    const laneKey = JSON.stringify([invocation.botId, invocation.threadId]);
    const laneInvocations = invocationsByLane.get(laneKey) ?? [];
    laneInvocations.push(invocation);
    invocationsByLane.set(laneKey, laneInvocations);
  }

  const activeInvocations = Array.from(invocationsByLane.values())
    .flatMap((laneInvocations) => {
      const newestInvocation = [...laneInvocations].sort(compareInvocationsByRecency)[0];
      const newestEventfulInvocation = [...laneInvocations]
        .filter((invocation) => (eventsByInvocationId.get(invocation.id)?.length ?? 0) > 0)
        .sort(compareInvocationsByRecency)[0];
      const displayInvocation = newestEventfulInvocation ?? newestInvocation;
      const displayRow = {
        invocation: displayInvocation,
        events: eventsByInvocationId.get(displayInvocation.id) ?? [],
      };
      const pendingApprovalRows = laneInvocations
        .filter((invocation) => invocation.id !== displayInvocation.id)
        .filter((invocation) =>
          deriveApprovalStates(eventsByInvocationId.get(invocation.id) ?? [], {}).some(
            (approval) => approval.status === "pending",
          ),
        )
        .map((invocation) => ({
          invocation,
          events: eventsByInvocationId.get(invocation.id) ?? [],
        }));
      return [displayRow, ...pendingApprovalRows];
    })
    .sort((left, right) => compareInvocationsByRecency(left.invocation, right.invocation));

  return {
    invocations: activeInvocations,
    typingSuppressedUserIds: Array.from(
      new Set(scopedInvocations.map((invocation) => invocation.botUserId)),
    ),
  };
}

function compareInvocationsByRecency(
  left: BotInvocationPublic,
  right: BotInvocationPublic,
): number {
  return invocationTimestamp(right) - invocationTimestamp(left);
}

function invocationTimestamp(invocation: BotInvocationPublic): number {
  const parsed = Date.parse(invocation.startedAt ?? invocation.createdAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

function updatedTimestamp(invocation: BotInvocationPublic): number {
  const parsed = Date.parse(invocation.updatedAt);
  return Number.isFinite(parsed) ? parsed : invocationTimestamp(invocation);
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
