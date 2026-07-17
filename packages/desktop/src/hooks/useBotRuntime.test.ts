import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BotInvocationProgressEventPublic,
  BotInvocationPublic,
  BotRuntimeSnapshot,
} from "@thechat/shared";
import { api } from "../lib/api";
import { createQueryWrapper, createTestQueryClient } from "../test-utils/query";
import {
  botRuntimeQueryKey,
  hasActiveBotRuntimeActivity,
  useBotRuntime,
  useBotRuntimeCache,
} from "./useBotRuntime";

vi.mock("../lib/api", () => ({
  api: {
    "bot-runtime": {
      conversations: vi.fn(),
    },
  },
}));

describe("useBotRuntime", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("reuses fresh cached runtime snapshots", async () => {
    const snapshot = runtime();
    const get = vi.fn(() => Promise.resolve({ data: snapshot, error: null }));
    vi.mocked(api["bot-runtime"].conversations).mockReturnValue({ get } as any);
    const client = createTestQueryClient();
    const wrapper = createQueryWrapper(client);

    const first = renderHook(
      () => useBotRuntime("conversation-1", "token-1"),
      { wrapper },
    );

    await waitFor(() => {
      expect(first.result.current.data).toEqual(snapshot);
    });
    first.unmount();

    const second = renderHook(
      () => useBotRuntime("conversation-1", "token-1"),
      { wrapper },
    );

    expect(second.result.current.data).toEqual(snapshot);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("keeps cached runtime visible when a refresh fails", async () => {
    const snapshot = runtime();
    const get = vi
      .fn()
      .mockResolvedValueOnce({ data: snapshot, error: null })
      .mockResolvedValueOnce({
        data: null,
        error: { value: { error: "runtime failed" } },
      });
    vi.mocked(api["bot-runtime"].conversations).mockReturnValue({ get } as any);

    const { result } = renderHook(
      () => useBotRuntime("conversation-1", "token-1"),
      { wrapper: createQueryWrapper() },
    );

    await waitFor(() => {
      expect(result.current.data).toEqual(snapshot);
    });

    let refetchError: unknown = null;
    await act(async () => {
      const refetchResult = await result.current.refetch();
      refetchError = refetchResult.error;
    });

    expect(get).toHaveBeenCalledTimes(2);
    expect(result.current.data).toEqual(snapshot);
    expect(refetchError).toBeInstanceOf(Error);
    expect((refetchError as Error).message).toContain("runtime failed");
  });

  it("patches runtime query data from websocket updates", () => {
    const client = createTestQueryClient();
    client.setQueryData<BotRuntimeSnapshot>(
      botRuntimeQueryKey("conversation-1"),
      runtime({
        invocations: [invocation({ status: "running" })],
        events: [progressEvent()],
      }),
    );

    const { result } = renderHook(() => useBotRuntimeCache(), {
      wrapper: createQueryWrapper(client),
    });

    act(() => {
      result.current.mergeInvocationUpdate(
        "conversation-1",
        invocation({ status: "completed" }),
      );
    });

    expect(
      client.getQueryData<BotRuntimeSnapshot>(
        botRuntimeQueryKey("conversation-1"),
      ),
    ).toMatchObject({
      invocations: [],
      events: [],
    });
  });

  it("ignores late websocket progress after a terminal sequence", () => {
    const client = createTestQueryClient();
    const { result } = renderHook(() => useBotRuntimeCache(), {
      wrapper: createQueryWrapper(client),
    });
    const running = invocation({ status: "running" });
    const terminal = progressEvent({
      id: "event-terminal",
      sequence: 2,
      type: "invocation.completed",
      status: "completed",
    });

    const olderTerminal = progressEvent({
      id: "event-terminal-retry",
      sequence: 1,
      type: "invocation.completed",
      status: "completed",
    });
    const lateProgress = progressEvent({ id: "event-late", sequence: 2 });

    act(() => {
      result.current.mergeProgressEvent("conversation-1", progressEvent(), running);
      result.current.mergeProgressEvent("conversation-1", terminal, running);
      result.current.mergeProgressEvent("conversation-1", olderTerminal, running);
      result.current.mergeInvocationUpdate("conversation-1", running);
      result.current.mergeProgressEvent("conversation-1", lateProgress, running);
    });

    expect(client.getQueryData<BotRuntimeSnapshot>(
      botRuntimeQueryKey("conversation-1"),
    )).toEqual({
      invocations: [],
      events: [terminal],
    });
  });

  it("keeps a terminal barrier across an authoritative empty refetch", async () => {
    const claimed = invocation({ status: "claimed" });
    const liveProgress = progressEvent({
      id: "event-live",
      sequence: 1,
    });
    const initial = runtime({
      invocations: [claimed],
      events: [liveProgress],
    });
    const get = vi
      .fn()
      .mockResolvedValueOnce({ data: initial, error: null })
      .mockResolvedValueOnce({ data: runtime(), error: null });
    vi.mocked(api["bot-runtime"].conversations).mockReturnValue({ get } as any);
    const client = createTestQueryClient();

    const { result } = renderHook(
      () => ({
        query: useBotRuntime("conversation-1", "token-1"),
        cache: useBotRuntimeCache(),
      }),
      { wrapper: createQueryWrapper(client) },
    );

    await waitFor(() => {
      expect(result.current.query.data).toEqual(initial);
    });

    const terminal = progressEvent({
      id: "event-terminal",
      sequence: 2,
      type: "invocation.completed",
      status: "completed",
    });
    act(() => {
      result.current.cache.mergeProgressEvent("conversation-1", terminal, claimed);
    });

    await act(async () => {
      await result.current.query.refetch();
    });
    await waitFor(() => {
      expect(client.getQueryData<BotRuntimeSnapshot>(
        botRuntimeQueryKey("conversation-1"),
      )).toEqual(runtime());
    });

    act(() => {
      result.current.cache.mergeProgressEvent(
        "conversation-1",
        liveProgress,
        claimed,
      );
    });

    expect(client.getQueryData<BotRuntimeSnapshot>(
      botRuntimeQueryKey("conversation-1"),
    )).toEqual(runtime());
  });

  it("does not resurrect terminal work from a higher fallback sequence epoch", () => {
    const client = createTestQueryClient();
    const { result } = renderHook(() => useBotRuntimeCache(), {
      wrapper: createQueryWrapper(client),
    });
    const claimed = invocation({ status: "claimed" });
    const terminal = progressEvent({
      id: "redis-terminal",
      sequence: 1,
      type: "invocation.completed",
      status: "completed",
    });
    const delayedOutageProgress = progressEvent({
      id: "fallback-progress",
      sequence: 3,
      type: "tool.started",
    });

    act(() => {
      result.current.mergeProgressEvent("conversation-1", terminal, claimed);
      result.current.mergeProgressEvent(
        "conversation-1",
        delayedOutageProgress,
        claimed,
      );
    });

    expect(client.getQueryData<BotRuntimeSnapshot>(
      botRuntimeQueryKey("conversation-1"),
    )).toEqual({
      invocations: [],
      events: [terminal],
    });
  });

  it("applies duplicate progress and terminal replays idempotently", () => {
    const client = createTestQueryClient();
    const { result } = renderHook(() => useBotRuntimeCache(), {
      wrapper: createQueryWrapper(client),
    });
    const claimed = invocation({ status: "claimed" });
    const progress = progressEvent({ id: "event-progress", sequence: 1 });
    const terminal = progressEvent({
      id: "event-terminal",
      sequence: 2,
      type: "invocation.completed",
      status: "completed",
    });

    act(() => {
      result.current.mergeProgressEvent("conversation-1", progress, claimed);
      result.current.mergeProgressEvent("conversation-1", progress, claimed);
    });
    expect(client.getQueryData<BotRuntimeSnapshot>(
      botRuntimeQueryKey("conversation-1"),
    )).toEqual({
      invocations: [claimed],
      events: [progress],
    });

    act(() => {
      result.current.mergeProgressEvent("conversation-1", terminal, claimed);
      result.current.mergeProgressEvent("conversation-1", terminal, claimed);
    });
    expect(client.getQueryData<BotRuntimeSnapshot>(
      botRuntimeQueryKey("conversation-1"),
    )).toEqual({
      invocations: [],
      events: [terminal],
    });
  });

  it("bounds retained terminal barriers without blocking unrelated invocations", () => {
    const client = createTestQueryClient();
    const { result } = renderHook(() => useBotRuntimeCache(), {
      wrapper: createQueryWrapper(client),
    });

    act(() => {
      for (let index = 0; index <= 500; index += 1) {
        const invocationId = `terminal-invocation-${index}`;
        result.current.mergeProgressEvent(
          "conversation-1",
          progressEvent({
            id: `terminal-event-${index}`,
            invocationId,
            sequence: 1,
            type: "invocation.completed",
            status: "completed",
          }),
          invocation({ id: invocationId, status: "claimed" }),
        );
      }
    });

    const unrelated = invocation({
      id: "unrelated-active-invocation",
      status: "claimed",
    });
    const unrelatedProgress = progressEvent({
      id: "unrelated-active-progress",
      invocationId: unrelated.id,
    });
    act(() => {
      result.current.mergeProgressEvent(
        "conversation-1",
        unrelatedProgress,
        unrelated,
      );
      result.current.mergeProgressEvent(
        "conversation-1",
        progressEvent({
          id: "latest-terminal-replay",
          invocationId: "terminal-invocation-500",
          sequence: 1,
          type: "tool.started",
        }),
        invocation({ id: "terminal-invocation-500", status: "claimed" }),
      );
    });

    const snapshot = client.getQueryData<BotRuntimeSnapshot>(
      botRuntimeQueryKey("conversation-1"),
    );
    expect(snapshot?.events.filter((event) =>
      event.type === "invocation.completed"
    ).length).toBeLessThanOrEqual(500);
    expect(snapshot?.invocations).toEqual([unrelated]);
    expect(snapshot?.events).toContainEqual(unrelatedProgress);
  });

  it("preserves a terminal barrier through snapshot replacement while accepting unrelated work", async () => {
    const finished = invocation({ id: "invocation-finished", status: "claimed" });
    const finishedProgress = progressEvent({
      id: "finished-progress",
      invocationId: finished.id,
      sequence: 1,
    });
    const unrelated = invocation({
      id: "invocation-unrelated",
      status: "claimed",
      threadId: "thread-2",
    });
    const unrelatedProgress = progressEvent({
      id: "unrelated-progress",
      invocationId: unrelated.id,
      threadId: "thread-2",
      sequence: 1,
    });
    const replacement = runtime({
      invocations: [unrelated],
      events: [unrelatedProgress],
    });
    const get = vi
      .fn()
      .mockResolvedValueOnce({
        data: runtime({
          invocations: [finished],
          events: [finishedProgress],
        }),
        error: null,
      })
      .mockResolvedValueOnce({ data: replacement, error: null });
    vi.mocked(api["bot-runtime"].conversations).mockReturnValue({ get } as any);
    const client = createTestQueryClient();

    const { result } = renderHook(
      () => ({
        query: useBotRuntime("conversation-1", "token-1"),
        cache: useBotRuntimeCache(),
      }),
      { wrapper: createQueryWrapper(client) },
    );
    await waitFor(() => {
      expect(result.current.query.data?.invocations).toEqual([finished]);
    });

    const terminal = progressEvent({
      id: "finished-terminal",
      invocationId: finished.id,
      sequence: 2,
      type: "invocation.completed",
      status: "completed",
    });
    act(() => {
      result.current.cache.mergeProgressEvent("conversation-1", terminal, finished);
    });
    await act(async () => {
      await result.current.query.refetch();
    });

    act(() => {
      result.current.cache.mergeProgressEvent(
        "conversation-1",
        finishedProgress,
        finished,
      );
    });

    expect(client.getQueryData<BotRuntimeSnapshot>(
      botRuntimeQueryKey("conversation-1"),
    )).toEqual(replacement);
  });

  it("polls for queued deliveries, webhook runs, and transient Hermes progress", () => {
    expect(hasActiveBotRuntimeActivity(runtime({
      invocations: [invocation({ status: "queued" })],
    }))).toBe(true);
    expect(hasActiveBotRuntimeActivity(runtime({
      invocations: [invocation({ status: "claimed" })],
      events: [progressEvent()],
    }))).toBe(true);
    expect(hasActiveBotRuntimeActivity(runtime({
      invocations: [invocation({ status: "running" })],
    }))).toBe(false);
    expect(hasActiveBotRuntimeActivity(runtime({
      invocations: [invocation({ botKind: "webhook", status: "running" })],
    }))).toBe(true);
  });

});

function runtime(overrides: Partial<BotRuntimeSnapshot> = {}): BotRuntimeSnapshot {
  return {
    invocations: [],
    events: [],
    ...overrides,
  };
}

function invocation(
  overrides: Partial<BotInvocationPublic> = {},
): BotInvocationPublic {
  return {
    id: "invocation-1",
    botId: "bot-1",
    botUserId: "bot-user-1",
    botName: "Koda",
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
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function progressEvent(
  overrides: Partial<BotInvocationProgressEventPublic> = {},
): BotInvocationProgressEventPublic {
  return {
    id: "event-1",
    invocationId: "invocation-1",
    botId: "bot-1",
    conversationId: "conversation-1",
    threadId: null,
    sequence: 1,
    type: "tool_call",
    status: "running",
    toolCallId: "tool-call-1",
    toolName: "read_file",
    label: "Reading file",
    preview: null,
    payload: null,
    occurredAt: "2026-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}
