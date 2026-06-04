import { describe, expect, it } from "vitest";
import type {
  BotInvocationProgressEventPublic,
  BotInvocationPublic,
  BotRuntimeSnapshot,
} from "@thechat/shared";
import { selectHermesConversationProgress } from "./hermes-progress";

describe("Hermes progress selectors", () => {
  it("shows active Hermes progress across the continuous conversation", () => {
    const snapshot = runtime({
      invocations: [
        invocation({
          id: "invocation-context-1",
          botUserId: "bot-user-1",
        }),
        invocation({
          id: "invocation-context-2",
          botUserId: "bot-user-1",
        }),
      ],
      events: [
        progressEvent({ id: "event-context-1", invocationId: "invocation-context-1" }),
        progressEvent({ id: "event-context-2", invocationId: "invocation-context-2" }),
      ],
    });

    const selected = selectHermesConversationProgress(snapshot);

    expect(selected.invocations.map(({ invocation }) => invocation.id)).toEqual([
      "invocation-context-1",
      "invocation-context-2",
    ]);
    expect(selected.invocations.flatMap(({ events }) => events.map((event) => event.id))).toEqual([
      "event-context-1",
      "event-context-2",
    ]);
    expect(selected.typingSuppressedUserIds).toEqual(["bot-user-1"]);
  });

  it("suppresses typing for all active Hermes bots", () => {
    const snapshot = runtime({
      invocations: [
        invocation({
          id: "first-bot",
          botUserId: "bot-user-1",
        }),
        invocation({
          id: "second-bot",
          botUserId: "bot-user-2",
        }),
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
    hermesSession: null,
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
