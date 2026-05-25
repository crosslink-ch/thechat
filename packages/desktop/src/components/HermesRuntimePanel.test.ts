import { describe, expect, it } from "vitest";
import type {
  BotInvocationProgressEventPublic,
  BotInvocationPublic,
  BotRuntimeSnapshot,
} from "@thechat/shared";
import {
  mergeRuntimeProgressEvent,
  mergeRuntimeUpdate,
} from "./HermesRuntimePanel";

describe("Hermes runtime progress state", () => {
  it("keeps only the latest progress events for an active invocation", () => {
    let snapshot: BotRuntimeSnapshot = {
      sessions: [],
      invocations: [invocation({ status: "running" })],
      events: [],
    };

    for (let sequence = 1; sequence <= 105; sequence += 1) {
      snapshot = mergeRuntimeProgressEvent(snapshot, progressEvent(sequence));
    }

    expect(snapshot.events).toHaveLength(100);
    expect(snapshot.events[0].sequence).toBe(6);
    expect(snapshot.events.at(-1)?.sequence).toBe(105);
  });

  it("drops progress events once an invocation is no longer active", () => {
    const runningInvocation = invocation({ status: "running" });
    const snapshot = mergeRuntimeProgressEvent(
      { sessions: [], invocations: [runningInvocation], events: [] },
      progressEvent(1),
    );

    const completed = invocation({ status: "completed" });
    const updated = mergeRuntimeUpdate(snapshot, null, completed);

    expect(updated.events).toEqual([]);
  });
});

function invocation(
  overrides: Partial<BotInvocationPublic> = {},
): BotInvocationPublic {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    id: "invocation-1",
    botSessionId: "session-1",
    botId: "bot-1",
    botUserId: "bot-user-1",
    botName: "Hermes",
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

function progressEvent(sequence: number): BotInvocationProgressEventPublic {
  const timestamp = new Date(Date.UTC(2026, 0, 1, 0, 0, sequence)).toISOString();
  return {
    id: `event-${sequence}`,
    invocationId: "invocation-1",
    botId: "bot-1",
    conversationId: "conversation-1",
    sequence,
    type: "tool.started",
    status: "running",
    toolCallId: `call-${sequence}`,
    toolName: "shell",
    label: `Shell ${sequence}`,
    preview: null,
    payload: null,
    occurredAt: timestamp,
    createdAt: timestamp,
  };
}
