import { beforeEach, describe, expect, it } from "vitest";
import type {
  BotInvocationProgressEventPublic,
  BotInvocationPublic,
} from "@thechat/shared";
import {
  hermesScopeKey,
  resolveHermesApprovalIndicator,
  useHermesIndicatorsStore,
} from "./hermes-indicators";

function makeInvocation(
  overrides: Partial<BotInvocationPublic> = {},
): BotInvocationPublic {
  return {
    id: "inv-1",
    botId: "bot-1",
    botUserId: "u-bot",
    botName: "Hermes",
    botKind: "hermes",
    conversationId: "conv-1",
    threadId: null,
    triggerMessageId: "msg-1",
    responseMessageId: null,
    adapterKind: "hermes",
    status: "running",
    externalRunId: null,
    hermesSession: null,
    requestJson: null,
    responseJson: null,
    error: null,
    startedAt: "2026-06-11T10:00:00.000Z",
    completedAt: null,
    createdAt: "2026-06-11T10:00:00.000Z",
    updatedAt: "2026-06-11T10:00:00.000Z",
    ...overrides,
  };
}

function makeEvent(
  overrides: Partial<BotInvocationProgressEventPublic> = {},
): BotInvocationProgressEventPublic {
  return {
    id: "evt-1",
    invocationId: "inv-1",
    botId: "bot-1",
    conversationId: "conv-1",
    threadId: null,
    sequence: 1,
    type: "approval.request",
    status: null,
    toolCallId: null,
    toolName: null,
    label: null,
    preview: null,
    payload: null,
    occurredAt: "2026-06-11T10:01:00.000Z",
    createdAt: "2026-06-11T10:01:00.000Z",
    ...overrides,
  };
}

const store = () => useHermesIndicatorsStore.getState();

describe("useHermesIndicatorsStore", () => {
  beforeEach(() => {
    store().resetForTests();
  });

  describe("unread scopes", () => {
    it("marks a scope unread when an observed-active invocation finishes off-screen", () => {
      store().trackInvocation(makeInvocation({ threadId: "t-1", status: "running" }));
      store().trackInvocation(makeInvocation({ threadId: "t-1", status: "completed" }));

      const scopeKey = hermesScopeKey("conv-1", "t-1");
      expect(store().unreadScopes[scopeKey]).toEqual({
        conversationId: "conv-1",
        threadId: "t-1",
        botUserId: "u-bot",
      });
    });

    it("does not mark the visible scope unread", () => {
      store().setVisibleScope(hermesScopeKey("conv-1", null));
      store().trackInvocation(makeInvocation({ status: "running" }));
      store().trackInvocation(makeInvocation({ status: "completed" }));

      expect(store().unreadScopes).toEqual({});
    });

    it("ignores terminal updates that were never observed active", () => {
      // The server may re-publish already-terminal invocations; those must
      // not re-mark a scope the user has already read.
      store().trackInvocation(makeInvocation({ status: "completed" }));

      expect(store().unreadScopes).toEqual({});
    });

    it("does not mark unread for cancelled invocations", () => {
      store().trackInvocation(makeInvocation({ status: "running" }));
      store().trackInvocation(makeInvocation({ status: "cancelled" }));

      expect(store().unreadScopes).toEqual({});
    });

    it("ignores non-hermes invocations", () => {
      store().trackInvocation(makeInvocation({ botKind: "webhook", status: "running" }));
      store().trackInvocation(makeInvocation({ botKind: "webhook", status: "failed" }));

      expect(store().unreadScopes).toEqual({});
      expect(store().invocationMeta).toEqual({});
    });

    it("clears unread when the scope becomes visible", () => {
      store().trackInvocation(makeInvocation({ status: "running" }));
      store().trackInvocation(makeInvocation({ status: "failed" }));
      const scopeKey = hermesScopeKey("conv-1", null);
      expect(store().unreadScopes[scopeKey]).toBeDefined();

      store().setVisibleScope(scopeKey);

      expect(store().unreadScopes).toEqual({});
      expect(store().visibleScope).toBe(scopeKey);
    });
  });

  describe("pending approvals", () => {
    it("tracks approval requests and dedupes by event id", () => {
      store().trackProgressEvent(makeEvent({ id: "evt-1" }));
      store().trackProgressEvent(makeEvent({ id: "evt-1" }));

      expect(store().pendingApprovals).toHaveLength(1);
      expect(store().pendingApprovals[0]).toMatchObject({
        eventId: "evt-1",
        invocationId: "inv-1",
        conversationId: "conv-1",
        threadId: null,
      });
    });

    it("fills thread and bot metadata from the tracked invocation", () => {
      store().trackInvocation(makeInvocation({ threadId: "t-1", status: "queued" }));
      store().trackProgressEvent(makeEvent({ threadId: null }));

      expect(store().pendingApprovals[0]).toMatchObject({
        threadId: "t-1",
        botUserId: "u-bot",
      });
    });

    it("resolves the oldest pending approval per invocation", () => {
      store().trackProgressEvent(makeEvent({ id: "evt-1", sequence: 1 }));
      store().trackProgressEvent(makeEvent({ id: "evt-2", sequence: 2 }));

      store().trackProgressEvent(
        makeEvent({ id: "evt-3", sequence: 3, type: "approval.resolved" }),
      );

      expect(store().pendingApprovals.map((p) => p.eventId)).toEqual(["evt-2"]);
    });

    it("resolves all pending approvals when the resolution carries resolveAll", () => {
      store().trackProgressEvent(makeEvent({ id: "evt-1", sequence: 1 }));
      store().trackProgressEvent(makeEvent({ id: "evt-2", sequence: 2 }));

      store().trackProgressEvent(
        makeEvent({
          id: "evt-3",
          sequence: 3,
          type: "approval.resolved",
          payload: { resolveAll: true },
        }),
      );

      expect(store().pendingApprovals).toEqual([]);
    });

    it("only resolves approvals of the resolution's invocation", () => {
      store().trackProgressEvent(makeEvent({ id: "evt-1", invocationId: "inv-1" }));
      store().trackProgressEvent(makeEvent({ id: "evt-2", invocationId: "inv-2" }));

      store().trackProgressEvent(
        makeEvent({ id: "evt-3", invocationId: "inv-2", type: "approval.resolved" }),
      );

      expect(store().pendingApprovals.map((p) => p.eventId)).toEqual(["evt-1"]);
    });

    it("drops pending approvals when their invocation finishes", () => {
      store().trackInvocation(makeInvocation({ status: "running" }));
      store().trackProgressEvent(makeEvent({ id: "evt-1" }));

      store().trackInvocation(makeInvocation({ status: "cancelled" }));

      expect(store().pendingApprovals).toEqual([]);
    });

    it("resolves a pending approval by event id (local decision)", () => {
      store().trackProgressEvent(makeEvent({ id: "evt-1" }));

      resolveHermesApprovalIndicator("evt-1");

      expect(store().pendingApprovals).toEqual([]);
    });
  });

  describe("seedFromSnapshot", () => {
    it("seeds pending approvals from active invocations only", () => {
      const active = makeInvocation({ id: "inv-1", threadId: "t-1", status: "running" });
      const done = makeInvocation({ id: "inv-2", status: "completed" });
      const snapshot = {
        invocations: [active, done],
        events: [
          makeEvent({ id: "evt-1", invocationId: "inv-1", threadId: "t-1" }),
          makeEvent({ id: "evt-2", invocationId: "inv-2" }),
        ],
      };

      store().seedFromSnapshot("conv-1", snapshot, {});

      expect(store().pendingApprovals.map((p) => p.eventId)).toEqual(["evt-1"]);
      expect(store().pendingApprovals[0]).toMatchObject({
        invocationId: "inv-1",
        threadId: "t-1",
        botUserId: "u-bot",
      });
    });

    it("skips approvals already resolved by a local decision", () => {
      const snapshot = {
        invocations: [makeInvocation({ status: "running" })],
        events: [makeEvent({ id: "evt-1" })],
      };

      store().seedFromSnapshot("conv-1", snapshot, { "evt-1": "once" });

      expect(store().pendingApprovals).toEqual([]);
    });

    it("replaces previously seeded approvals for the same conversation but keeps other conversations", () => {
      store().trackProgressEvent(
        makeEvent({ id: "evt-other", invocationId: "inv-9", conversationId: "conv-2" }),
      );
      store().seedFromSnapshot(
        "conv-1",
        {
          invocations: [makeInvocation({ status: "running" })],
          events: [makeEvent({ id: "evt-1" })],
        },
        {},
      );

      store().seedFromSnapshot(
        "conv-1",
        {
          invocations: [makeInvocation({ status: "running" })],
          events: [makeEvent({ id: "evt-2" })],
        },
        {},
      );

      expect(store().pendingApprovals.map((p) => p.eventId).sort()).toEqual([
        "evt-2",
        "evt-other",
      ]);
    });

    it("registers active invocations so later terminal updates mark unread", () => {
      store().seedFromSnapshot(
        "conv-1",
        {
          invocations: [makeInvocation({ status: "running" })],
          events: [],
        },
        {},
      );

      store().trackInvocation(makeInvocation({ status: "completed" }));

      expect(store().unreadScopes[hermesScopeKey("conv-1", null)]).toBeDefined();
    });
  });
});
