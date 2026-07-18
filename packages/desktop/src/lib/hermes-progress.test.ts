import { describe, expect, it } from "vitest";
import type {
  BotInvocationProgressEventPublic,
  BotInvocationPublic,
  BotRuntimeSnapshot,
} from "@thechat/shared";
import { pendingApprovalEvents } from "./hermes-approvals";
import { selectHermesConversationProgress } from "./hermes-progress";

describe("Hermes progress selectors", () => {
  it("coalesces overlapping invocations for one Hermes conversation lane", () => {
    const snapshot = runtime({
      invocations: [
        invocation({
          id: "invocation-context-1",
          botUserId: "bot-user-1",
          startedAt: "2026-01-01T00:00:00.000Z",
        }),
        invocation({
          id: "invocation-context-2",
          botUserId: "bot-user-1",
          startedAt: "2026-01-01T00:00:01.000Z",
        }),
      ],
      events: [
        progressEvent({
          id: "event-context-1",
          invocationId: "invocation-context-1",
          occurredAt: "2026-01-01T00:00:00.500Z",
        }),
      ],
    });

    const handoffSelected = selectHermesConversationProgress(snapshot);
    expect(handoffSelected.invocations).toHaveLength(1);
    expect(handoffSelected.invocations[0]?.invocation.id).toBe("invocation-context-1");
    expect(handoffSelected.invocations[0]?.events.map((event) => event.id)).toEqual([
      "event-context-1",
    ]);

    const replacementSelected = selectHermesConversationProgress({
      ...snapshot,
      events: [
        ...snapshot.events,
        progressEvent({
          id: "event-context-2",
          invocationId: "invocation-context-2",
          occurredAt: "2026-01-01T00:00:01.500Z",
        }),
      ],
    });

    expect(replacementSelected.invocations.map(({ invocation }) => invocation.id)).toEqual([
      "invocation-context-2",
    ]);
    expect(
      replacementSelected.invocations.flatMap(({ events }) => events.map((event) => event.id)),
    ).toEqual(["event-context-2"]);
    expect(replacementSelected.typingSuppressedUserIds).toEqual(["bot-user-1"]);
  });

  it("preserves pending approvals from an older invocation during a lane handoff", () => {
    const snapshot = runtime({
      invocations: [
        invocation({
          id: "approval-invocation",
          startedAt: "2026-01-01T00:00:00.000Z",
          createdAt: "2026-01-01T00:00:00.000Z",
        }),
        invocation({
          id: "replacement-invocation",
          startedAt: "2026-01-01T00:00:01.000Z",
          createdAt: "2026-01-01T00:00:01.000Z",
        }),
      ],
      events: [
        progressEvent({
          id: "approval-event",
          invocationId: "approval-invocation",
          type: "approval.request",
          status: "waiting",
          occurredAt: "2026-01-01T00:00:00.500Z",
        }),
        progressEvent({
          id: "replacement-event",
          invocationId: "replacement-invocation",
          occurredAt: "2026-01-01T00:00:01.500Z",
        }),
      ],
    });

    const selected = selectHermesConversationProgress(snapshot);

    expect(selected.invocations.map(({ invocation }) => invocation.id)).toEqual([
      "replacement-invocation",
      "approval-invocation",
    ]);
    expect(pendingApprovalEvents(selected.invocations, {}).map((event) => event.id)).toEqual([
      "approval-event",
    ]);
  });

  it("suppresses typing for all active Hermes bots", () => {
    const snapshot = runtime({
      invocations: [
        invocation({
          id: "first-bot",
          botId: "bot-1",
          botUserId: "bot-user-1",
        }),
        invocation({
          id: "second-bot",
          botId: "bot-2",
          botUserId: "bot-user-2",
        }),
      ],
      events: [
        progressEvent({ invocationId: "first-bot" }),
        progressEvent({ id: "event-2", invocationId: "second-bot" }),
      ],
    });

    const selected = selectHermesConversationProgress(snapshot);

    expect(selected.invocations.map(({ invocation }) => invocation.id)).toEqual([
      "first-bot",
      "second-bot",
    ]);
    expect(selected.typingSuppressedUserIds.sort()).toEqual([
      "bot-user-1",
      "bot-user-2",
    ]);
  });

  it("uses queued delivery or transient progress rather than invocation status as liveness", () => {
    const snapshot = runtime({
      invocations: [
        invocation({
          id: "claimed-invocation",
          status: "claimed",
        }),
        invocation({
          id: "legacy-running-invocation",
          status: "running",
        }),
        invocation({
          id: "queued-invocation",
          botId: "bot-2",
          botUserId: "bot-user-2",
          botName: "Hermes Two",
          status: "queued",
        }),
      ],
    });

    const deliveryOnly = selectHermesConversationProgress(snapshot);
    expect(deliveryOnly.invocations.map(({ invocation }) => invocation.id)).toEqual([
      "queued-invocation",
    ]);

    const waiting = selectHermesConversationProgress(
      {
        ...snapshot,
        events: [
          progressEvent({
            invocationId: "claimed-invocation",
            type: "approval.request",
            status: "waiting",
          }),
        ],
      },
    );
    expect(waiting.invocations.map(({ invocation }) => invocation.id)).toEqual([
      "claimed-invocation",
      "queued-invocation",
    ]);
  });

  it("scopes General progress to unthreaded Hermes invocations", () => {
    const snapshot = runtime({
      invocations: [
        invocation({ id: "general-invocation", threadId: null }),
        invocation({ id: "task-invocation", threadId: "thread-1" }),
      ],
      events: [
        progressEvent({ id: "general-event", invocationId: "general-invocation", threadId: null }),
        progressEvent({ id: "task-event", invocationId: "task-invocation", threadId: "thread-1" }),
      ],
    });

    const selected = selectHermesConversationProgress(snapshot, null, {
      unthreadedOnly: true,
    });

    expect(selected.invocations.map(({ invocation }) => invocation.id)).toEqual([
      "general-invocation",
    ]);
    expect(selected.invocations.flatMap(({ events }) => events.map((event) => event.id))).toEqual(["general-event"]);
  });

  it("scopes task progress to the selected thread", () => {
    const snapshot = runtime({
      invocations: [
        invocation({ id: "first-task", threadId: "thread-1" }),
        invocation({ id: "second-task", threadId: "thread-2" }),
      ],
      events: [
        progressEvent({ id: "first-event", invocationId: "first-task", threadId: "thread-1" }),
        progressEvent({ id: "second-event", invocationId: "second-task", threadId: "thread-2" }),
      ],
    });

    const allThreads = selectHermesConversationProgress(snapshot);
    expect(
      allThreads.invocations.map(({ invocation }) => invocation.id).sort(),
    ).toEqual(["first-task", "second-task"]);

    const selected = selectHermesConversationProgress(snapshot, "thread-2");

    expect(selected.invocations.map(({ invocation }) => invocation.id)).toEqual([
      "second-task",
    ]);
    expect(selected.invocations.flatMap(({ events }) => events.map((event) => event.id))).toEqual(["second-event"]);
  });

  it("ignores completed invocations and non-Hermes bots", () => {
    const snapshot = runtime({
      invocations: [
        invocation({ id: "active-hermes" }),
        invocation({ id: "completed-hermes", status: "completed" }),
        invocation({ id: "webhook-bot", botKind: "webhook" }),
      ],
      events: [
        progressEvent({ id: "active-event", invocationId: "active-hermes" }),
        progressEvent({ id: "completed-event", invocationId: "completed-hermes" }),
        progressEvent({ id: "webhook-event", invocationId: "webhook-bot" }),
      ],
    });

    const selected = selectHermesConversationProgress(snapshot);

    expect(selected.invocations.map(({ invocation }) => invocation.id)).toEqual([
      "active-hermes",
    ]);
    expect(selected.invocations.flatMap(({ events }) => events.map((event) => event.id))).toEqual(["active-event"]);
    expect(selected.typingSuppressedUserIds).toEqual(["bot-user-1"]);
  });
});

function runtime(
  overrides: Partial<BotRuntimeSnapshot> = {},
): BotRuntimeSnapshot {
  return {
    invocations: [],
    events: [],
    ...overrides,
  };
}

function invocation(
  overrides: Partial<BotInvocationPublic> = {},
): BotInvocationPublic {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    id: "invocation-1",
    botId: "bot-1",
    botUserId: "bot-user-1",
    botName: "Koda",
    botKind: "hermes",
    conversationId: "conversation-1",
    threadId: null,
    triggerMessageId: "message-1",
    responseMessageId: null,
    adapterKind: "hermes",
    status: "running",
    externalRunId: null,
    requestJson: null,
    responseJson: null,
    error: null,
    startedAt: now,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function progressEvent(
  overrides: Partial<BotInvocationProgressEventPublic> = {},
): BotInvocationProgressEventPublic {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    id: "event-1",
    invocationId: "invocation-1",
    botId: "bot-1",
    conversationId: "conversation-1",
    threadId: null,
    sequence: 1,
    type: "tool.started",
    status: null,
    toolCallId: "tool-call-1",
    toolName: "shell",
    label: "Reading files",
    preview: null,
    payload: null,
    occurredAt: now,
    createdAt: now,
    ...overrides,
  };
}
