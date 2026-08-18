import { describe, expect, it } from "vitest";
import type { BotInvocationProgressEventPublic } from "@thechat/shared";
import { deriveClarifyStates } from "./hermes-clarifications";

describe("deriveClarifyStates", () => {
  it("matches explicit requestId resolutions and leaves older requests pending", () => {
    const states = deriveClarifyStates(
      [
        event("clarify.request", 1, {
          requestId: "request-1",
          sessionKey: "session-1",
        }),
        event("clarify.request", 2, {
          requestId: "request-2",
          sessionKey: "session-1",
        }),
        event("clarify.resolved", 3, {
          requestId: "request-2",
          response: ["Unit", "Build"],
        }),
      ],
      {},
    );

    expect(states.map((state) => state.status)).toEqual(["pending", "resolved"]);
    expect(states[1]).toMatchObject({
      response: ["Unit", "Build"],
      confirmed: true,
    });
  });

  it("falls back to FIFO for older resolution events", () => {
    const states = deriveClarifyStates(
      [
        event("clarify.request", 1, { sessionKey: "session-1" }),
        event("clarify.request", 2, { sessionKey: "session-1" }),
        event("clarify.resolved", 3, {
          sessionKey: "session-1",
          answer: "First answer",
        }),
      ],
      {},
    );
    expect(states.map((state) => state.status)).toEqual(["resolved", "pending"]);
    expect(states[0].response).toBe("First answer");
  });

  it("applies accepted local responses only while gateway confirmation is absent", () => {
    const request = event("clarify.request", 1, { requestId: "request-1" });
    expect(deriveClarifyStates([request], { [request.id]: "Local answer" })[0])
      .toMatchObject({
        status: "resolved",
        response: "Local answer",
        confirmed: false,
      });
  });
});

function event(
  type: string,
  sequence: number,
  payload: Record<string, unknown>,
): BotInvocationProgressEventPublic {
  const createdAt = `2026-01-01T00:00:0${sequence}.000Z`;
  return {
    id: `${type}-${sequence}`,
    invocationId: "invocation-1",
    botId: "bot-1",
    conversationId: "conversation-1",
    threadId: null,
    sequence,
    type,
    status: type.endsWith(".request") ? "waiting" : "completed",
    toolCallId: null,
    toolName: null,
    label: null,
    preview: null,
    payload,
    occurredAt: createdAt,
    createdAt,
  };
}
