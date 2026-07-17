import { createElement } from "react";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type {
  BotInvocationProgressEventPublic,
  BotInvocationPublic,
  BotRuntimeSnapshot,
  ConversationThreadPublic,
} from "@thechat/shared";
import {
  mergeRuntimeProgressEvent,
  mergeRuntimeUpdate,
} from "../lib/bot-runtime-state";
import { HermesRuntimePanel } from "./HermesRuntimePanel";

describe("HermesRuntimePanel", () => {
  it("renders queued General and task deliveries and counts them without progress", () => {
    renderPanel(runtime({
      invocations: [
        invocation({
          id: "queued-general",
          status: "queued",
          requestJson: { text: "Queued General delivery" },
        }),
        invocation({
          id: "queued-task",
          status: "queued",
          threadId: "thread-1",
          requestJson: { text: "Queued task delivery" },
        }),
      ],
    }));

    expect(screen.getByText("Queued General delivery")).toBeInTheDocument();
    expect(screen.getByText("Queued task delivery")).toBeInTheDocument();
    expect(screen.getAllByText("queued")).toHaveLength(2);
    expect(within(generalRow()).getByText("1")).toBeInTheDocument();
    expect(within(taskRow()).getByText("1")).toBeInTheDocument();
  });

  it("renders claimed transient progress in the matching task scope", () => {
    renderPanel(runtime({
      invocations: [
        invocation({
          status: "claimed",
          threadId: "thread-1",
          requestJson: { text: "Claimed task work" },
        }),
      ],
      events: [progressEvent(1, { threadId: "thread-1" })],
    }));

    expect(screen.getByText("Claimed task work")).toBeInTheDocument();
    expect(screen.getByText("claimed")).toBeInTheDocument();
    expect(within(taskRow()).getByText("1")).toBeInTheDocument();
    expect(within(generalRow()).queryByText("1")).not.toBeInTheDocument();
  });

  it("hides claimed and legacy running invocations that have no progress", () => {
    renderPanel(runtime({
      invocations: [
        invocation({
          id: "silent-claimed",
          status: "claimed",
          requestJson: { text: "Silent claimed work" },
        }),
        invocation({
          id: "silent-running",
          status: "running",
          threadId: "thread-1",
          requestJson: { text: "Silent running work" },
        }),
      ],
    }));

    expect(screen.getByText("No active runs")).toBeInTheDocument();
    expect(screen.queryByText("Silent claimed work")).not.toBeInTheDocument();
    expect(screen.queryByText("Silent running work")).not.toBeInTheDocument();
    expect(within(generalRow()).queryByText("1")).not.toBeInTheDocument();
    expect(within(taskRow()).queryByText("1")).not.toBeInTheDocument();
  });

  it("does not let progress for one invocation activate another", () => {
    renderPanel(runtime({
      invocations: [
        invocation({
          id: "eventful-invocation",
          status: "claimed",
          requestJson: { text: "Eventful invocation" },
        }),
        invocation({
          id: "unrelated-invocation",
          status: "claimed",
          requestJson: { text: "Unrelated invocation" },
        }),
      ],
      events: [progressEvent(1, { invocationId: "eventful-invocation" })],
    }));

    expect(screen.getByText("Eventful invocation")).toBeInTheDocument();
    expect(screen.queryByText("Unrelated invocation")).not.toBeInTheDocument();
    expect(within(generalRow()).getByText("1")).toBeInTheDocument();
  });

  it("filters non-Hermes invocations even when they are queued or eventful", () => {
    renderPanel(runtime({
      invocations: [
        invocation({
          botKind: "webhook",
          status: "queued",
          requestJson: { text: "Webhook activity" },
        }),
      ],
      events: [progressEvent(1)],
    }));

    expect(screen.getByText("No active runs")).toBeInTheDocument();
    expect(screen.queryByText("Webhook activity")).not.toBeInTheDocument();
    expect(within(generalRow()).queryByText("1")).not.toBeInTheDocument();
  });
});

describe("Hermes runtime progress state", () => {
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

function renderPanel(snapshot: BotRuntimeSnapshot) {
  return render(createElement(HermesRuntimePanel, {
    botName: "Koda",
    runtime: snapshot,
    loading: false,
    threads: [thread()],
  }));
}

function generalRow() {
  return screen.getByRole("button", { name: /General\s*Inbox/ });
}

function taskRow() {
  return screen.getByRole("button", { name: /Release task/ });
}

function runtime(overrides: Partial<BotRuntimeSnapshot> = {}): BotRuntimeSnapshot {
  return {
    invocations: [],
    events: [],
    ...overrides,
  };
}

function thread(
  overrides: Partial<ConversationThreadPublic> = {},
): ConversationThreadPublic {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    id: "thread-1",
    conversationId: "conversation-1",
    botId: "bot-1",
    title: "Release task",
    status: "active",
    createdById: "user-1",
    lastActivityAt: now,
    createdAt: now,
    updatedAt: now,
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
