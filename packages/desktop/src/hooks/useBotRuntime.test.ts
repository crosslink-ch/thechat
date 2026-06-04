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
    hermesSession: null,
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
