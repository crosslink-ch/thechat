import { beforeEach, expect, it } from "vitest";
import type {
  BotInvocationProgressEventPublic,
  BotInvocationPublic,
} from "@thechat/shared";
import { resetPrivateSession } from "../lib/session-boundary";
import {
  recordClarifyResponse,
  useHermesClarificationsStore,
} from "./hermes-clarifications";
import { useHermesIndicatorsStore } from "./hermes-indicators";

beforeEach(() => {
  useHermesClarificationsStore.getState().resetForTests();
  useHermesIndicatorsStore.getState().resetForTests();
});

it("does not let an old session's accepted answer suppress a fresh pending snapshot", () => {
  const invocation: BotInvocationPublic = {
    id: "inv-1", botId: "bot-1", botUserId: "u-bot", botName: "Hermes",
    botKind: "hermes", conversationId: "conv-1", threadId: null,
    triggerMessageId: "msg-1", responseMessageId: null, adapterKind: "hermes",
    status: "claimed", externalRunId: null, requestJson: null,
    responseJson: null, error: null, startedAt: "2026-09-09T10:00:00.000Z",
    completedAt: null, createdAt: "2026-09-09T10:00:00.000Z",
    updatedAt: "2026-09-09T10:00:00.000Z",
  };
  const request: BotInvocationProgressEventPublic = {
    id: "clarify-session-reset", invocationId: invocation.id, botId: "bot-1",
    conversationId: "conv-1", threadId: null, sequence: 1,
    type: "clarify.request", status: "waiting", toolCallId: null,
    toolName: null, label: null, preview: null,
    payload: {
      requestId: "request-1", sessionKey: "hermes-session-1",
      question: "Which region?", choices: ["US", "EU"],
      multiSelect: false, allowOther: true,
    },
    occurredAt: "2026-09-09T10:01:00.000Z",
    createdAt: "2026-09-09T10:01:00.000Z",
  };
  const snapshot = { invocations: [invocation], events: [request] };
  const seed = () => useHermesIndicatorsStore.getState().seedFromSnapshot(
    "conv-1", snapshot, {}, useHermesClarificationsStore.getState().responses,
  );

  seed();
  expect(useHermesIndicatorsStore.getState().pendingClarifications).toHaveLength(1);
  recordClarifyResponse(request.id, "Asia Pacific");
  seed();
  expect(useHermesIndicatorsStore.getState().pendingClarifications).toEqual([]);

  resetPrivateSession();
  seed();

  expect(useHermesIndicatorsStore.getState().pendingClarifications).toEqual([
    expect.objectContaining({ eventId: request.id }),
  ]);
  expect(useHermesClarificationsStore.getState().responses).toEqual({});
  expect(useHermesClarificationsStore.getState().responseOrder).toEqual([]);
});
