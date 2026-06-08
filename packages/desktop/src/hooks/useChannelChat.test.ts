import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { InfiniteData } from "@tanstack/react-query";
import type { ChatMessage } from "@thechat/shared";
import {
  MESSAGE_PAGE_SIZE,
  MESSAGE_WINDOW_TRIM_THRESHOLD,
  MESSAGE_WINDOW_SIZE,
  messagesQueryKey,
  useChannelChat,
} from "./useChannelChat";
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
  createdAt = new Date().toISOString(),
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
    createdAt,
  };
}

interface TestMessagePage {
  messages: ChatMessage[];
  hasOlder: boolean;
}

function messageWindow(
  messages: ChatMessage[],
  hasOlder = false,
): InfiniteData<TestMessagePage, string | null> {
  return {
    pages: [{ messages, hasOlder }],
    pageParams: [null],
  };
}

function flattenWindow(
  window: InfiniteData<TestMessagePage, string | null> | undefined,
) {
  return window?.pages.flatMap((page) => page.messages).map((m) => m.content);
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
      query: { limit: MESSAGE_PAGE_SIZE },
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
    client.setQueryData(
      messagesQueryKey("dm-hermes", "thread-2"),
      messageWindow([message("dm-hermes", "second prompt", "thread-2")]),
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
      flattenWindow(
        client.getQueryData<InfiniteData<TestMessagePage, string | null>>(
          messagesQueryKey("dm-hermes", "thread-2"),
        ),
      ),
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
      query: { limit: MESSAGE_PAGE_SIZE, unthreaded: "true" },
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

  it("loads older messages before the current oldest cursor", async () => {
    const recent = Array.from({ length: MESSAGE_PAGE_SIZE }, (_, i) =>
      message(
        "dm-paged",
        `recent ${i}`,
        null,
        `2026-01-01T00:${String(20 + i).padStart(2, "0")}:00.000Z`,
      ),
    );
    const older = [
      message("dm-paged", "older 0", null, "2026-01-01T00:18:00.000Z"),
      message("dm-paged", "older 1", null, "2026-01-01T00:19:00.000Z"),
    ];
    const get = vi.fn(({ query }: { query: Record<string, unknown> }) =>
      Promise.resolve({ data: query.before ? older : recent }),
    );
    vi.mocked(api.messages).mockReturnValue({ get } as any);

    const { result } = renderHook(
      () =>
        useChannelChat({
          conversationId: "dm-paged",
          token: "test-token",
          wsSendMessage: vi.fn(),
        }),
      { wrapper: createQueryWrapper() },
    );

    await waitFor(() => {
      expect(result.current.messages.map((m) => m.content)).toEqual(
        recent.map((m) => m.content),
      );
    });
    expect(result.current.hasOlderMessages).toBe(true);

    await act(async () => {
      await result.current.loadOlderMessages();
    });

    expect(get).toHaveBeenLastCalledWith({
      query: { limit: MESSAGE_PAGE_SIZE, before: recent[0].createdAt },
      headers: { authorization: "Bearer test-token" },
    });
    await waitFor(() => {
      expect(result.current.messages.map((m) => m.content)).toEqual([
        "older 0",
        "older 1",
        ...recent.map((m) => m.content),
      ]);
    });
  });

  it("trims the visible cache on append only after the threshold", async () => {
    vi.mocked(api.messages).mockReturnValue({
      get: vi.fn(() =>
        Promise.resolve({ data: [message("dm-trim", "initial")] }),
      ),
    } as any);

    const { result } = renderHook(
      () =>
        useChannelChat({
          conversationId: "dm-trim",
          token: "test-token",
          wsSendMessage: vi.fn(),
        }),
      { wrapper: createQueryWrapper() },
    );

    await waitFor(() => {
      expect(result.current.messages.map((m) => m.content)).toEqual(["initial"]);
    });

    act(() => {
      for (let i = 0; i < MESSAGE_WINDOW_TRIM_THRESHOLD - 1; i += 1) {
        result.current.addMessage(message("dm-trim", `live ${i}`));
      }
    });

    await waitFor(() => {
      expect(result.current.messages).toHaveLength(MESSAGE_WINDOW_TRIM_THRESHOLD);
    });

    act(() => {
      result.current.addMessage(
        message("dm-trim", `live ${MESSAGE_WINDOW_TRIM_THRESHOLD - 1}`),
      );
    });

    await waitFor(() => {
      expect(result.current.messages).toHaveLength(MESSAGE_WINDOW_SIZE);
      expect(result.current.messages[0].content).toBe(
        `live ${MESSAGE_WINDOW_TRIM_THRESHOLD - MESSAGE_WINDOW_SIZE}`,
      );
      expect(result.current.hasOlderMessages).toBe(true);
    });
  });
});
