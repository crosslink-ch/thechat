import { describe, expect, it } from "vitest";
import { useHermesIndicatorsStore } from "../stores/hermes-indicators";
import type {
  BotInvocationProgressEventPublic,
  BotInvocationPublic,
  BotRuntimeSnapshot,
} from "@thechat/shared";
import {
  mergeRuntimeProgressEvent,
  mergeRuntimeUpdate,
} from "../lib/bot-runtime-state";

describe("Hermes runtime progress state", () => {
  it("hydrates background state without older snapshots overwriting newer revisions", () => {
    const store = useHermesIndicatorsStore.getState(); store.resetForTests();
    const newer = {botId:"bot",taskId:"durable-task",sequence:4,parent:{state:"verifying"},conversationId:"conversation-1"} as any;
    store.seedFromSnapshot("conversation-1", {invocations:[],events:[],activity:[newer]}, {}, {});
    store.seedFromSnapshot("conversation-1", {invocations:[],events:[],activity:[{...newer,sequence:3,parent:{state:"waiting_worker"}}]}, {}, {});
    expect(useHermesIndicatorsStore.getState().backgroundActivity).toEqual({"bot:durable-task":newer});
    store.resetForTests();
    expect(useHermesIndicatorsStore.getState().backgroundActivity).toEqual({});
  });
  it("keeps background tasks independent when foreground invocation completion clears progress", () => {
    const activity = [{botId:"bot",taskId:"durable-task",sequence:4,parent:{state:"waiting_worker"}}] as any;
    const snapshot = {invocations:[invocation({status:"running"})],events:[progressEvent(1)],activity};
    expect(mergeRuntimeUpdate(snapshot, invocation({status:"completed"})).activity).toEqual(activity);
    expect(mergeRuntimeProgressEvent(snapshot, progressEvent(2,{type:"invocation.completed"})).activity).toEqual(activity);
  });
  it("keeps only the latest progress events for an active invocation", () => {
    let snapshot: BotRuntimeSnapshot = {
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
      { invocations: [runningInvocation], events: [] },
      progressEvent(1),
    );

    const completed = invocation({ status: "completed" });
    const updated = mergeRuntimeUpdate(snapshot, completed);

    expect(updated.events).toEqual([]);
    expect(updated.invocations).toEqual([]);
  });

  it("keeps claimed invocation metadata only while transient progress exists", () => {
    const claimed = invocation({ status: "claimed" });

    expect(mergeRuntimeUpdate(null, claimed)).toEqual({
      invocations: [],
      events: [],
    });

    const withProgress = mergeRuntimeProgressEvent(null, progressEvent(1), claimed);
    expect(withProgress.invocations).toEqual([claimed]);
    expect(withProgress.events).toHaveLength(1);

    const refreshed = mergeRuntimeUpdate(withProgress, claimed);
    expect(refreshed.invocations).toEqual([claimed]);
    expect(refreshed.events).toHaveLength(1);
  });

  it("does not keep a stale legacy running invocation without progress", () => {
    expect(mergeRuntimeUpdate(null, invocation({ status: "running" }))).toEqual({
      invocations: [],
      events: [],
    });
  });

  it("removes invocation metadata and approvals on terminal progress", () => {
    const claimed = invocation({ status: "claimed" });
    const active = mergeRuntimeProgressEvent(null, progressEvent(1), claimed);
    const withApproval = mergeRuntimeProgressEvent(
      active,
      progressEvent(2, { type: "approval.request", toolCallId: null }),
      claimed,
    );

    const completed = mergeRuntimeProgressEvent(
      withApproval,
      progressEvent(3, {
        type: "invocation.completed",
        status: "completed",
        toolCallId: null,
      }),
      claimed,
    );

    expect(completed.invocations).toEqual([]);
    expect(completed.events).toEqual([
      expect.objectContaining({
        sequence: 3,
        type: "invocation.completed",
      }),
    ]);
  });

  it("reconciles a failed queued dispatch without dropping other active runs", () => {
    const runningInvocation = invocation({
      id: "running-task",
      status: "running",
      threadId: "thread-running",
    });
    const queuedInvocation = invocation({
      id: "queued-task",
      status: "queued",
      threadId: "thread-queued",
    });
    const snapshot: BotRuntimeSnapshot = {
      invocations: [runningInvocation, queuedInvocation],
      events: [
        progressEvent(1, { invocationId: "running-task" }),
        progressEvent(2, { invocationId: "queued-task" }),
      ],
    };

    const updated = mergeRuntimeUpdate(
      snapshot,
      invocation({
        id: "queued-task",
        status: "failed",
        threadId: "thread-queued",
        error: "Hermes dispatch timed out",
      }),
    );

    expect(updated.invocations).toEqual([runningInvocation]);
    expect(updated.events).toEqual([
      expect.objectContaining({ invocationId: "running-task" }),
    ]);
  });
});

function invocation(
  overrides: Partial<BotInvocationPublic> = {},
): BotInvocationPublic {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    id: "invocation-1",
    botId: "bot-1",
    botUserId: "bot-user-1",
    botName: "Hermes",
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
  sequence: number,
  overrides: Partial<BotInvocationProgressEventPublic> = {},
): BotInvocationProgressEventPublic {
  const timestamp = new Date(Date.UTC(2026, 0, 1, 0, 0, sequence)).toISOString();
  return {
    id: `event-${sequence}`,
    invocationId: "invocation-1",
    botId: "bot-1",
    conversationId: "conversation-1",
    threadId: null,
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
    ...overrides,
  };
}
