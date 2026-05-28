import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ChatMessage } from "@thechat/shared";
import { messagesQueryKey, useChannelChat } from "./useChannelChat";
import { api } from "../lib/api";
import { createQueryWrapper, createTestQueryClient } from "../test-utils/query";

vi.mock("../lib/api", () => ({
  api: {
    messages: vi.fn(),
  },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function message(
  conversationId: string,
  content: string,
  threadId: string | null = null,
): ChatMessage {
  return {
    id: crypto.randomUUID(),
    conversationId,
    threadId,
    senderId: "sender-1",
    senderName: "Sender",
    senderType: "human",
    content,
    parts: null,
    createdAt: new Date().toISOString(),
  };
}

describe("useChannelChat", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("clears old messages and ignores stale fetches when switching conversations", async () => {
    const first = deferred<{ data: ChatMessage[] }>();
    const second = deferred<{ data: ChatMessage[] }>();
    vi.mocked(api.messages).mockImplementation((params: { conversationId: string | number }) => {
      const conversationId = String(params.conversationId);
      return {
        get: vi.fn(() => (conversationId === "dm-first" ? first.promise : second.promise)),
      } as any;
    });

    const { result, rerender } = renderHook(
      ({ conversationId }: { conversationId: string }) =>
        useChannelChat({
          conversationId,
          token: "test-token",
          wsSendMessage: vi.fn(),
        }),
      {
        initialProps: { conversationId: "dm-first" },
        wrapper: createQueryWrapper(),
      },
    );

    await waitFor(() => expect(api.messages).toHaveBeenCalledTimes(1));

    rerender({ conversationId: "dm-second" });

    expect(result.current.messages).toEqual([]);
    await waitFor(() => expect(api.messages).toHaveBeenCalledTimes(2));

    act(() => {
      second.resolve({ data: [message("dm-second", "second history")] });
    });
    await waitFor(() => {
      expect(result.current.messages.map((m) => m.content)).toEqual(["second history"]);
    });

    act(() => {
      first.resolve({ data: [message("dm-first", "stale first history")] });
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(result.current.messages.map((m) => m.content)).toEqual(["second history"]);
  });

  it("refetches on demand while keeping the current history visible", async () => {
    const second = deferred<{ data: ChatMessage[] }>();
    vi.mocked(api.messages)
      .mockReturnValueOnce({
        get: vi.fn(() =>
          Promise.resolve({ data: [message("dm-refetch", "initial history")] }),
        ),
      } as any)
      .mockReturnValueOnce({
        get: vi.fn(() => second.promise),
      } as any);

    const { result } = renderHook(
      () =>
        useChannelChat({
          conversationId: "dm-refetch",
          token: "test-token",
          wsSendMessage: vi.fn(),
        }),
      { wrapper: createQueryWrapper() },
    );

    await waitFor(() => {
      expect(result.current.messages.map((m) => m.content)).toEqual([
        "initial history",
      ]);
    });

    act(() => {
      result.current.refetchMessages();
    });

    await waitFor(() => expect(api.messages).toHaveBeenCalledTimes(2));
    expect(result.current.messages.map((m) => m.content)).toEqual([
      "initial history",
    ]);

    act(() => {
      second.resolve({ data: [message("dm-refetch", "current refetch history")] });
    });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
      expect(result.current.messages.map((m) => m.content)).toEqual([
        "current refetch history",
      ]);
    });
  });

  it("keeps continuous live history and sends without a bot context", async () => {
    const history = deferred<{ data: ChatMessage[] }>();
    const get = vi.fn(() => history.promise);
    vi.mocked(api.messages).mockReturnValue({ get } as any);
    const wsSendMessage = vi.fn();

    const { result } = renderHook(
      () =>
        useChannelChat({
          conversationId: "dm-hermes",
          token: "test-token",
          wsSendMessage,
        }),
      { wrapper: createQueryWrapper() },
    );

    await waitFor(() => expect(api.messages).toHaveBeenCalledTimes(1));
    expect(get).toHaveBeenCalledWith({
      query: { limit: 50 },
      headers: { authorization: "Bearer test-token" },
    });

    act(() => {
      history.resolve({ data: [message("dm-hermes", "active history")] });
    });

    await waitFor(() => {
      expect(result.current.messages.map((m) => m.content)).toEqual(["active history"]);
    });

    act(() => {
      result.current.addMessage(message("dm-hermes", "other live"));
      result.current.addMessage(message("dm-hermes", "active live"));
      result.current.sendMessage("next");
    });

    await waitFor(() => {
      expect(result.current.messages.map((m) => m.content)).toEqual([
        "active history",
        "other live",
        "active live",
      ]);
    });
    expect(wsSendMessage).toHaveBeenCalledWith("dm-hermes", "next", null);
  });

  it("updates inactive task-thread caches from live messages", async () => {
    const get = vi.fn(() =>
      Promise.resolve({ data: [message("dm-hermes", "first history", "thread-1")] }),
    );
    vi.mocked(api.messages).mockReturnValue({ get } as any);
    const client = createTestQueryClient();
    client.setQueryData<ChatMessage[]>(
      messagesQueryKey("dm-hermes", "thread-2"),
      [message("dm-hermes", "second prompt", "thread-2")],
    );

    const { result, rerender } = renderHook(
      ({ threadId }: { threadId: string }) =>
        useChannelChat({
          conversationId: "dm-hermes",
          threadId,
          token: "test-token",
          wsSendMessage: vi.fn(),
        }),
      {
        initialProps: { threadId: "thread-1" },
        wrapper: createQueryWrapper(client),
      },
    );

    await waitFor(() => {
      expect(result.current.messages.map((m) => m.content)).toEqual(["first history"]);
    });

    act(() => {
      result.current.addMessage(message("dm-hermes", "second response", "thread-2"));
    });

    expect(result.current.messages.map((m) => m.content)).toEqual(["first history"]);
    expect(
      client
        .getQueryData<ChatMessage[]>(messagesQueryKey("dm-hermes", "thread-2"))
        ?.map((m) => m.content),
    ).toEqual(["second prompt", "second response"]);

    rerender({ threadId: "thread-2" });

    expect(result.current.messages.map((m) => m.content)).toEqual([
      "second prompt",
      "second response",
    ]);
  });

  it("keeps the Hermes General cache scoped to unthreaded messages", async () => {
    const get = vi.fn(() =>
      Promise.resolve({ data: [message("dm-hermes", "general history")] }),
    );
    vi.mocked(api.messages).mockReturnValue({ get } as any);
    const wsSendMessage = vi.fn();

    const { result } = renderHook(
      () =>
        useChannelChat({
          conversationId: "dm-hermes",
          threadId: null,
          unthreadedOnly: true,
          token: "test-token",
          wsSendMessage,
        }),
      { wrapper: createQueryWrapper() },
    );

    await waitFor(() => {
      expect(result.current.messages.map((m) => m.content)).toEqual([
        "general history",
      ]);
    });
    expect(get).toHaveBeenCalledWith({
      query: { limit: 50, unthreaded: "true" },
      headers: { authorization: "Bearer test-token" },
    });

    act(() => {
      result.current.addMessage(message("dm-hermes", "task live", "thread-1"));
      result.current.addMessage(message("dm-hermes", "general live"));
      result.current.sendMessage("next general");
    });

    await waitFor(() => {
      expect(result.current.messages.map((m) => m.content)).toEqual([
        "general history",
        "general live",
      ]);
    });
    expect(wsSendMessage).toHaveBeenCalledWith("dm-hermes", "next general", null);
  });

  it("reuses fresh cached history when remounting the same conversation", async () => {
    vi.mocked(api.messages).mockReturnValue({
      get: vi.fn(() =>
        Promise.resolve({ data: [message("dm-cache", "cached history")] }),
      ),
    } as any);
    const wsSendMessage = vi.fn();
    const client = createTestQueryClient();
    const wrapper = createQueryWrapper(client);

    const first = renderHook(() =>
      useChannelChat({
        conversationId: "dm-cache",
        token: "test-token",
        wsSendMessage,
      }),
      { wrapper },
    );

    await waitFor(() => {
      expect(first.result.current.messages.map((m) => m.content)).toEqual([
        "cached history",
      ]);
    });
    first.unmount();

    const second = renderHook(() =>
      useChannelChat({
        conversationId: "dm-cache",
        token: "test-token",
        wsSendMessage,
      }),
      { wrapper },
    );

    expect(second.result.current.loading).toBe(false);
    expect(second.result.current.messages.map((m) => m.content)).toEqual([
      "cached history",
    ]);
    expect(api.messages).toHaveBeenCalledTimes(1);
  });
});
