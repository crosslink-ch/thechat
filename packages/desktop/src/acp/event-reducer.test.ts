import { describe, expect, it } from "vitest";
import type { AcpEvent, AcpPermissionOption } from "@thechat/shared";
import { createAcpEventState, reduceAcpEvent } from "./event-reducer";

const conversationId = "conversation-1";
const generation = 7;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;
type AcpEventInput = DistributiveOmit<
  AcpEvent,
  "conversationId" | "generation"
>;

function event(
  value: AcpEventInput,
): AcpEvent {
  return { conversationId, generation, ...value } as AcpEvent;
}

function reduce(events: AcpEvent[]) {
  return events.reduce(
    reduceAcpEvent,
    createAcpEventState(conversationId, generation),
  );
}

describe("ACP event reducer", () => {
  it("coalesces ordered reasoning and text while upserting rich tool updates", () => {
    const state = reduce([
      event({ type: "turn_started", sequence: 1, turnId: "turn-1" }),
      event({ type: "reasoning_delta", sequence: 2, turnId: "turn-1", text: "Need " }),
      event({ type: "reasoning_delta", sequence: 3, turnId: "turn-1", text: "inspect." }),
      event({ type: "text_delta", sequence: 4, turnId: "turn-1", text: "Working " }),
      event({ type: "text_delta", sequence: 5, turnId: "turn-1", text: "on it." }),
      event({
        type: "tool_call",
        sequence: 6,
        turnId: "turn-1",
        toolCall: {
          id: "tool-1",
          name: "edit",
          title: "Edit package.json",
          kind: "edit",
          status: "pending",
          rawInput: { path: "package.json" },
          content: [{ type: "text", text: "Preparing edit" }],
          locations: [{ path: "package.json", line: 3 }],
        },
      }),
      event({
        type: "tool_call_update",
        sequence: 7,
        turnId: "turn-1",
        toolCallId: "tool-1",
        update: {
          status: "completed",
          rawOutput: { changed: true },
          content: [{ type: "text", text: "Edited package.json" }],
        },
      }),
    ]);

    expect(state.status).toBe("running");
    expect(state.lastSequence).toBe(7);
    expect(state.parts).toHaveLength(4);
    expect(state.parts[0]).toEqual({ type: "reasoning", text: "Need inspect." });
    expect(state.parts[1]).toEqual({ type: "text", text: "Working on it." });
    expect(state.parts[2]).toMatchObject({
      type: "tool-call",
      toolCallId: "tool-1",
      toolName: "edit",
      args: { path: "package.json" },
      acp: {
        title: "Edit package.json",
        kind: "edit",
        status: "completed",
        locations: [{ path: "package.json", line: 3 }],
        rawOutput: { changed: true },
        content: [{ type: "text", text: "Edited package.json" }],
      },
    });
    expect(state.parts[3]).toMatchObject({
      type: "tool-result",
      toolCallId: "tool-1",
      toolName: "edit",
      result: { changed: true },
      isError: false,
    });
  });

  it("merges a partial tool update that arrives before the initial tool call", () => {
    const state = reduce([
      event({
        type: "tool_call_update",
        sequence: 1,
        turnId: "turn-1",
        toolCallId: "tool-late",
        update: { title: "Late metadata", status: "in_progress" },
      }),
      event({
        type: "tool_call",
        sequence: 2,
        turnId: "turn-1",
        toolCall: {
          id: "tool-late",
          name: "shell",
          kind: "execute",
          status: "in_progress",
          rawInput: { command: "pnpm test" },
        },
      }),
    ]);

    expect(state.parts).toHaveLength(1);
    expect(state.parts[0]).toMatchObject({
      type: "tool-call",
      toolCallId: "tool-late",
      toolName: "shell",
      args: { command: "pnpm test" },
      acp: { title: "Late metadata", kind: "execute", status: "in_progress" },
    });
  });

  it("queues the exact offered ACP permission choices without inventing feedback", () => {
    const options: AcpPermissionOption[] = [
      { id: "allow-once-id", kind: "allow_once", label: "Allow once" },
      { id: "allow-always-id", kind: "allow_always", label: "Always allow" },
      { id: "reject-once-id", kind: "reject_once", label: "Reject once" },
      { id: "reject-always-id", kind: "reject_always", label: "Always reject" },
    ];
    const state = reduce([
      event({
        type: "permission_request",
        sequence: 1,
        turnId: "turn-1",
        permission: {
          id: "permission-1",
          toolCallId: "tool-1",
          title: "Run tests?",
          description: "pnpm test",
          options,
        },
      }),
    ]);

    expect(state.pendingPermissions).toEqual([
      expect.objectContaining({ id: "permission-1", options }),
    ]);
    expect(state.pendingPermissions[0]).not.toHaveProperty("feedback");
  });

  it("ignores duplicate, out-of-order, other-conversation, and stale-generation events", () => {
    const state = [
      event({ type: "text_delta", sequence: 1, turnId: "turn-1", text: "one" }),
      event({ type: "text_delta", sequence: 1, turnId: "turn-1", text: " duplicate" }),
      event({ type: "text_delta", sequence: 3, turnId: "turn-1", text: " three" }),
      event({ type: "text_delta", sequence: 2, turnId: "turn-1", text: " two" }),
      { ...event({ type: "text_delta", sequence: 4, turnId: "turn-1", text: " stale" }), generation: 6 },
      { ...event({ type: "text_delta", sequence: 5, turnId: "turn-1", text: " other" }), conversationId: "other" },
    ].reduce(reduceAcpEvent, createAcpEventState(conversationId, generation));

    expect(state.lastSequence).toBe(3);
    expect(state.ignoredEvents).toBe(4);
    expect(state.parts).toEqual([{ type: "text", text: "one three" }]);
  });

  it("clears permissions and becomes terminal on cancellation", () => {
    const state = reduce([
      event({ type: "turn_started", sequence: 1, turnId: "turn-cancelled" }),
      event({
        type: "permission_request",
        sequence: 2,
        turnId: "turn-cancelled",
        permission: {
          id: "permission-1",
          title: "Run?",
          options: [{ id: "reject", kind: "reject_once", label: "Reject" }],
        },
      }),
      event({
        type: "turn_cancelled",
        sequence: 3,
        turnId: "turn-cancelled",
        result: { stopReason: "cancelled" },
      }),
      event({ type: "text_delta", sequence: 4, turnId: "turn-cancelled", text: "too late" }),
    ]);

    expect(state.status).toBe("cancelled");
    expect(state.pendingPermissions).toEqual([]);
    expect(state.result).toEqual({ stopReason: "cancelled" });
    expect(state.ignoredEvents).toBe(1);
  });

  it("keeps cancellation monotonic until a terminal event arrives", () => {
    const running = reduce([
      event({ type: "turn_started", sequence: 1, turnId: "turn-cancelling" }),
    ]);
    const cancelling = { ...running, status: "cancelling" as const };
    const ignored = [
      event({
        type: "text_delta",
        sequence: 2,
        turnId: "turn-cancelling",
        text: "late text",
      }),
      event({
        type: "permission_request",
        sequence: 3,
        turnId: "turn-cancelling",
        permission: {
          id: "permission-late",
          title: "Late permission",
          options: [{ id: "reject", kind: "reject_once", label: "Reject" }],
        },
      }),
    ].reduce(reduceAcpEvent, cancelling);

    expect(ignored.status).toBe("cancelling");
    expect(ignored.parts).toEqual([]);
    expect(ignored.pendingPermissions).toEqual([]);
    expect(ignored.ignoredEvents).toBe(2);

    const cancelled = reduceAcpEvent(
      ignored,
      event({
        type: "turn_cancelled",
        sequence: 4,
        turnId: "turn-cancelling",
        result: { stopReason: "cancelled" },
      }),
    );
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.result).toEqual({ stopReason: "cancelled" });
  });

  it("records successful finish and adapter errors as distinct terminal states", () => {
    const finished = reduce([
      event({ type: "turn_started", sequence: 1, turnId: "turn-finished" }),
      event({
        type: "turn_finished",
        sequence: 2,
        turnId: "turn-finished",
        result: { stopReason: "end_turn", sessionId: "session-1" },
      }),
    ]);
    const failed = reduce([
      event({ type: "turn_started", sequence: 1, turnId: "turn-failed" }),
      event({
        type: "error",
        sequence: 2,
        turnId: "turn-failed",
        error: { code: "adapter_crashed", message: "adapter exited", fatal: true },
      }),
    ]);

    expect(finished.status).toBe("finished");
    expect(finished.result).toEqual({ stopReason: "end_turn", sessionId: "session-1" });
    expect(failed.status).toBe("error");
    expect(failed.error).toEqual({
      code: "adapter_crashed",
      message: "adapter exited",
      fatal: true,
    });
  });

  it("lets a lifecycle disconnect supersede a finished turn", () => {
    const finished = reduce([
      event({ type: "turn_started", sequence: 1, turnId: "turn-finished" }),
      event({
        type: "turn_finished",
        sequence: 2,
        turnId: "turn-finished",
        result: { stopReason: "end_turn" },
      }),
    ]);
    const disconnected = reduceAcpEvent(
      finished,
      event({
        type: "disconnected",
        sequence: 3,
        reason: "adapter exited while idle",
      }),
    );

    expect(disconnected.status).toBe("disconnected");
    expect(disconnected.error?.message).toBe("adapter exited while idle");
  });

  it("keeps explicitly nonfatal errors observable without sealing trailing updates", () => {
    const state = reduce([
      event({ type: "turn_started", sequence: 1, turnId: "turn-warning" }),
      event({
        type: "error",
        sequence: 2,
        turnId: "turn-warning",
        error: {
          code: "partial_update_failed",
          message: "One optional update was skipped",
          fatal: false,
          retryable: true,
        },
      }),
      event({
        type: "text_delta",
        sequence: 3,
        turnId: "turn-warning",
        text: "Valid trailing response",
      }),
      event({
        type: "turn_finished",
        sequence: 4,
        turnId: "turn-warning",
        result: { stopReason: "end_turn" },
      }),
    ]);

    expect(state.status).toBe("finished");
    expect(state.error).toMatchObject({
      code: "partial_update_failed",
      fatal: false,
    });
    expect(state.parts).toEqual([
      { type: "text", text: "Valid trailing response" },
    ]);
    expect(state.lastSequence).toBe(4);
  });
});
