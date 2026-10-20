import { beforeEach, describe, expect, it } from "vitest";
import type {
  BotInvocationProgressEventPublic,
  BotInvocationPublic,
} from "@thechat/shared";
import {
  hermesScopeKey,
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
    type: "tool.started",
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
      store().trackInvocation(makeInvocation({ threadId: "t-1", status: "queued" }));
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
      store().trackInvocation(makeInvocation({ status: "queued" }));
      store().trackInvocation(makeInvocation({ status: "completed" }));

      expect(store().unreadScopes).toEqual({});
    });

    it("drops queued lifecycle metadata when Hermes claims delivery", () => {
      store().trackInvocation(makeInvocation({ status: "queued" }));
      expect(store().invocationMeta["inv-1"]).toBeDefined();

      store().trackInvocation(makeInvocation({ status: "claimed" }));

      expect(store().invocationMeta["inv-1"]).toBeUndefined();
      expect(store().unreadScopes).toEqual({});
    });

    it("retains progress metadata until a claimed completion event arrives", () => {
      store().trackProgressEvent(
        makeEvent({ type: "tool.started" }),
        makeInvocation({ status: "claimed" }),
      );
      store().trackInvocation(
        makeInvocation({
          status: "claimed",
          responseJson: { completion: { type: "silent" } },
        }),
      );
      expect(store().invocationMeta["inv-1"]).toBeDefined();

      const completed = makeInvocation({
        status: "claimed",
        responseJson: { completion: { type: "silent" } },
      });
      store().trackProgressEvent(
        makeEvent({ type: "invocation.completed", sequence: 2 }),
        completed,
      );

      expect(store().invocationMeta["inv-1"]).toBeUndefined();
      expect(store().unreadScopes[hermesScopeKey("conv-1", null)]).toBeDefined();

      store().trackProgressEvent(
        makeEvent({ type: "invocation.completed", sequence: 1 }),
        completed,
      );
      store().trackProgressEvent(
        makeEvent({ type: "tool.started", sequence: 2 }),
        makeInvocation({ status: "running" }),
      );
      expect(store().terminalSequences["inv-1"]).toBe(2);
      expect(store().invocationMeta["inv-1"]).toBeUndefined();
    });

    it("ignores terminal updates that were never observed active", () => {
      // The server may re-publish already-terminal invocations; those must
      // not re-mark a scope the user has already read.
      store().trackInvocation(makeInvocation({ status: "completed" }));

      expect(store().unreadScopes).toEqual({});
    });

    it("does not mark unread for cancelled invocations", () => {
      store().trackInvocation(makeInvocation({ status: "queued" }));
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
      store().trackInvocation(makeInvocation({ status: "queued" }));
      store().trackInvocation(makeInvocation({ status: "failed" }));
      const scopeKey = hermesScopeKey("conv-1", null);
      expect(store().unreadScopes[scopeKey]).toBeDefined();

      store().setVisibleScope(scopeKey);

      expect(store().unreadScopes).toEqual({});
      expect(store().visibleScope).toBe(scopeKey);
    });

    it("marks General unread for offscreen messages and clears when viewed", () => {
      store().setVisibleScope(hermesScopeKey("conv-1", "t-1"));

      store().markScopeUnread({
        conversationId: "conv-1",
        threadId: null,
        botUserId: "u-bot",
      });

      const generalScopeKey = hermesScopeKey("conv-1", null);
      expect(store().unreadScopes[generalScopeKey]).toEqual({
        conversationId: "conv-1",
        threadId: null,
        botUserId: "u-bot",
      });

      store().setVisibleScope(generalScopeKey);

      expect(store().unreadScopes).toEqual({});
    });

    it("does not mark the currently visible scope unread for messages", () => {
      store().setVisibleScope(hermesScopeKey("conv-1", null));

      store().markScopeUnread({
        conversationId: "conv-1",
        threadId: null,
        botUserId: "u-bot",
      });

      expect(store().unreadScopes).toEqual({});
    });
  });

  describe("seedFromSnapshot", () => {
    it("registers active invocations so later terminal updates mark unread", () => {
      store().seedFromSnapshot({
        invocations: [makeInvocation({ status: "claimed" })],
        events: [makeEvent({ type: "tool.started" })],
      });

      store().trackInvocation(makeInvocation({ status: "completed" }));

      expect(store().unreadScopes[hermesScopeKey("conv-1", null)]).toBeDefined();
    });

    it("ignores finished invocations and idle claimed ones", () => {
      store().seedFromSnapshot({
        invocations: [
          makeInvocation({ id: "inv-done", status: "completed" }),
          makeInvocation({ id: "inv-idle", status: "claimed" }),
        ],
        events: [makeEvent({ invocationId: "inv-done" })],
      });

      expect(store().invocationMeta).toEqual({});
    });

    it("never derives requests from approval or clarify progress", () => {
      store().seedFromSnapshot({
        invocations: [makeInvocation({ status: "claimed" })],
        events: [
          makeEvent({ id: "evt-approval", type: "approval.request", status: "waiting" }),
          makeEvent({ id: "evt-clarify", type: "clarify.request", status: "waiting" }),
        ],
      });

      expect(Object.keys(store())).not.toContain("pendingApprovals");
      expect(Object.keys(store())).not.toContain("pendingClarifications");
      expect(store().invocationMeta["inv-1"]).toMatchObject({ conversationId: "conv-1" });
    });
  });
});
