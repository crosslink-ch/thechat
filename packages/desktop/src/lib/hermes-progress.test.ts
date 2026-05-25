import { describe, expect, it } from "vitest";
import type {
  BotInvocationProgressEventPublic,
  BotInvocationPublic,
  BotRuntimeSnapshot,
} from "@thechat/shared";
import {
  selectHermesConversationProgress,
  selectHermesSessionProgress,
} from "./hermes-progress";

describe("Hermes progress selectors", () => {
  it("scopes visible progress to the selected Hermes session", () => {
    const snapshot = runtime({
      invocations: [
        invocation({
          id: "invocation-session-1",
          botSessionId: "session-1",
          botUserId: "bot-user-1",
        }),
        invocation({
          id: "invocation-session-2",
          botSessionId: "session-2",
          botUserId: "bot-user-1",
        }),
      ],
      events: [
        progressEvent({ id: "event-session-1", invocationId: "invocation-session-1" }),
        progressEvent({ id: "event-session-2", invocationId: "invocation-session-2" }),
      ],
    });

    const selected = selectHermesSessionProgress(snapshot, "session-2");

    expect(selected.invocations.map((invocation) => invocation.id)).toEqual([
      "invocation-session-2",
    ]);
    expect(selected.events.map((event) => event.id)).toEqual(["event-session-2"]);
    expect(selected.typingSuppressedUserIds).toEqual(["bot-user-1"]);
  });

  it("suppresses typing for all active Hermes bots even when another session is selected", () => {
    const snapshot = runtime({
      invocations: [
        invocation({
          id: "selected-session",
          botSessionId: "session-2",
          botUserId: "bot-user-1",
        }),
        invocation({
          id: "other-session",
          botSessionId: "session-1",
          botUserId: "bot-user-2",
        }),
      ],
    });

    const selected = selectHermesSessionProgress(snapshot, "session-2");

    expect(selected.invocations.map((invocation) => invocation.id)).toEqual([
      "selected-session",
    ]);
    expect(selected.typingSuppressedUserIds.sort()).toEqual([
      "bot-user-1",
      "bot-user-2",
    ]);
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

    expect(selected.invocations.map((invocation) => invocation.id)).toEqual([
      "active-hermes",
    ]);
    expect(selected.events.map((event) => event.id)).toEqual(["active-event"]);
    expect(selected.typingSuppressedUserIds).toEqual(["bot-user-1"]);
  });
});

function runtime(
  overrides: Partial<BotRuntimeSnapshot> = {},
): BotRuntimeSnapshot {
  return {
    sessions: [],
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
    botSessionId: "session-1",
    botId: "bot-1",
    botUserId: "bot-user-1",
    botName: "Koda",
    botKind: "hermes",
    conversationId: "conversation-1",
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
