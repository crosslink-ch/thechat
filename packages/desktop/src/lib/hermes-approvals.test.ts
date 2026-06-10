import { describe, expect, it } from "vitest";
import type { BotInvocationProgressEventPublic } from "@thechat/shared";
import {
  decisionFromApprovalCommand,
  deriveApprovalStates,
  pendingApprovalEvents,
} from "./hermes-approvals";

describe("deriveApprovalStates", () => {
  it("keeps unanswered approval requests pending", () => {
    const states = deriveApprovalStates(
      [approvalRequest({ id: "a-1", sequence: 1 })],
      {},
    );

    expect(states).toHaveLength(1);
    expect(states[0].status).toBe("pending");
    expect(states[0].decision).toBeNull();
  });

  it("resolves the oldest pending request from an approval.resolved event", () => {
    const states = deriveApprovalStates(
      [
        approvalRequest({ id: "a-1", sequence: 1 }),
        approvalRequest({ id: "a-2", sequence: 2 }),
        resolution({ id: "r-1", sequence: 3, payload: { choice: "once" } }),
      ],
      {},
    );

    expect(states.map((state) => state.status)).toEqual(["resolved", "pending"]);
    expect(states[0].decision).toBe("once");
    expect(states[0].confirmed).toBe(true);
  });

  it("resolves all pending requests when the event carries resolveAll", () => {
    const states = deriveApprovalStates(
      [
        approvalRequest({ id: "a-1", sequence: 1 }),
        approvalRequest({ id: "a-2", sequence: 2 }),
        resolution({
          id: "r-1",
          sequence: 3,
          payload: { choice: "deny", resolveAll: true },
        }),
      ],
      {},
    );

    expect(states.map((state) => state.status)).toEqual(["resolved", "resolved"]);
    expect(states.map((state) => state.decision)).toEqual(["deny", "deny"]);
  });

  it("only resolves requests with a matching sessionKey", () => {
    const states = deriveApprovalStates(
      [
        approvalRequest({
          id: "a-1",
          sequence: 1,
          payload: { command: "x", sessionKey: "dm:other" },
        }),
        approvalRequest({
          id: "a-2",
          sequence: 2,
          payload: { command: "y", sessionKey: "dm:mine" },
        }),
        resolution({
          id: "r-1",
          sequence: 3,
          payload: { choice: "once", sessionKey: "dm:mine" },
        }),
      ],
      {},
    );

    expect(states.map((state) => state.status)).toEqual(["pending", "resolved"]);
  });

  it("applies local decisions without shifting event-based FIFO resolution", () => {
    // The user answered a-1 locally; the gateway's resolution event for that
    // same answer must still target a-1, not fall through to a-2.
    const states = deriveApprovalStates(
      [
        approvalRequest({ id: "a-1", sequence: 1 }),
        approvalRequest({ id: "a-2", sequence: 2 }),
        resolution({ id: "r-1", sequence: 3, payload: { choice: "once" } }),
      ],
      { "a-1": "once" },
    );

    expect(states[0].status).toBe("resolved");
    expect(states[0].confirmed).toBe(true);
    expect(states[1].status).toBe("pending");
  });

  it("resolves locally decided requests while waiting for the gateway", () => {
    const states = deriveApprovalStates(
      [approvalRequest({ id: "a-1", sequence: 1 })],
      { "a-1": "deny" },
    );

    expect(states[0].status).toBe("resolved");
    expect(states[0].decision).toBe("deny");
    expect(states[0].confirmed).toBe(false);
  });
});

describe("pendingApprovalEvents", () => {
  it("returns pending approvals across invocations oldest first", () => {
    const events = pendingApprovalEvents(
      [
        {
          invocation: { id: "inv-1" } as never,
          events: [
            approvalRequest({
              id: "a-newer",
              sequence: 1,
              createdAt: "2026-01-01T00:00:05.000Z",
            }),
          ],
        },
        {
          invocation: { id: "inv-2" } as never,
          events: [
            approvalRequest({
              id: "a-older",
              sequence: 1,
              createdAt: "2026-01-01T00:00:01.000Z",
            }),
            approvalRequest({
              id: "a-decided",
              sequence: 2,
              createdAt: "2026-01-01T00:00:02.000Z",
            }),
          ],
        },
      ],
      { "a-decided": "once" },
    );

    expect(events.map((event) => event.id)).toEqual(["a-older", "a-newer"]);
  });
});

describe("decisionFromApprovalCommand", () => {
  it("parses approve variants like the gateway", () => {
    expect(decisionFromApprovalCommand("/approve")).toEqual({
      decision: "once",
      all: false,
    });
    expect(decisionFromApprovalCommand("/approve session")).toEqual({
      decision: "session",
      all: false,
    });
    expect(decisionFromApprovalCommand("/approve always")).toEqual({
      decision: "always",
      all: false,
    });
    expect(decisionFromApprovalCommand("/approve all permanently")).toEqual({
      decision: "always",
      all: true,
    });
    expect(decisionFromApprovalCommand("/deny all")).toEqual({
      decision: "deny",
      all: true,
    });
  });

  it("ignores unrelated commands and lookalikes", () => {
    expect(decisionFromApprovalCommand("/approvex")).toBeNull();
    expect(decisionFromApprovalCommand("/stop")).toBeNull();
    expect(decisionFromApprovalCommand("approve")).toBeNull();
  });
});

function approvalRequest(
  overrides: Partial<BotInvocationProgressEventPublic> = {},
): BotInvocationProgressEventPublic {
  return progressEvent({
    type: "approval.request",
    status: "waiting",
    payload: { command: "rm -rf /tmp/x" },
    ...overrides,
  });
}

function resolution(
  overrides: Partial<BotInvocationProgressEventPublic> = {},
): BotInvocationProgressEventPublic {
  return progressEvent({
    type: "approval.resolved",
    status: "completed",
    ...overrides,
  });
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
    toolCallId: null,
    toolName: null,
    label: null,
    preview: null,
    payload: null,
    occurredAt: now,
    createdAt: now,
    ...overrides,
  };
}
