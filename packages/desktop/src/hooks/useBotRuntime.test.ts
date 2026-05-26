import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BotInvocationProgressEventPublic,
  BotInvocationPublic,
  BotRuntimeSnapshot,
  BotSessionPublic,
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
        session(),
        invocation({ status: "completed" }),
      );
    });

    expect(
      client.getQueryData<BotRuntimeSnapshot>(
        botRuntimeQueryKey("conversation-1"),
      ),
    ).toMatchObject({
      sessions: [{ id: "session-1" }],
      invocations: [],
      events: [],
    });
  });

  it("updates context summaries from bot messages", () => {
    const client = createTestQueryClient();
    client.setQueryData<BotRuntimeSnapshot>(
      botRuntimeQueryKey("conversation-1"),
      runtime({
        sessions: [
          session({ id: "session-1", updatedAt: "2026-01-01T00:00:00.000Z" }),
          session({ id: "session-2", updatedAt: "2026-01-01T00:00:00.000Z" }),
        ],
      }),
    );

    const { result } = renderHook(() => useBotRuntimeCache(), {
      wrapper: createQueryWrapper(client),
    });

    act(() => {
      result.current.mergeMessageUpdate("conversation-1", {
        id: "message-2",
        conversationId: "conversation-1",
        botSessionId: "session-2",
        senderId: "bot-user-1",
        senderName: "Koda",
        senderType: "bot",
        content: "Cron result",
        parts: null,
        createdAt: "2026-01-01T00:05:00.000Z",
      });
    });

    expect(
      client.getQueryData<BotRuntimeSnapshot>(
        botRuntimeQueryKey("conversation-1"),
      )?.sessions.map((item) => ({
        id: item.id,
        lastMessageId: item.lastMessageId,
        lastMessagePreview: item.lastMessagePreview,
        lastMessageSenderName: item.lastMessageSenderName,
        lastMessageCreatedAt: item.lastMessageCreatedAt,
      })),
    ).toEqual([
      {
        id: "session-2",
        lastMessageId: "message-2",
        lastMessagePreview: "Cron result",
        lastMessageSenderName: "Koda",
        lastMessageCreatedAt: "2026-01-01T00:05:00.000Z",
      },
      {
        id: "session-1",
        lastMessageId: null,
        lastMessagePreview: null,
        lastMessageSenderName: null,
        lastMessageCreatedAt: null,
      },
    ]);
  });

});

function runtime(overrides: Partial<BotRuntimeSnapshot> = {}): BotRuntimeSnapshot {
  return {
    sessions: [],
    invocations: [],
    events: [],
    ...overrides,
  };
}

function session(overrides: Partial<BotSessionPublic> = {}): BotSessionPublic {
  return {
    id: "session-1",
    botId: "bot-1",
    botUserId: "bot-user-1",
    botName: "Koda",
    botKind: "hermes",
    workspaceId: "workspace-1",
    conversationId: "conversation-1",
    scope: "conversation",
    externalSessionId: "external-session-1",
    title: "Default session",
    lastMessageId: null,
    lastMessagePreview: null,
    lastMessageSenderName: null,
    lastMessageCreatedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function invocation(
  overrides: Partial<BotInvocationPublic> = {},
): BotInvocationPublic {
  return {
    id: "invocation-1",
    botSessionId: "session-1",
    botId: "bot-1",
    botUserId: "bot-user-1",
    botName: "Koda",
    botKind: "hermes",
    conversationId: "conversation-1",
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
