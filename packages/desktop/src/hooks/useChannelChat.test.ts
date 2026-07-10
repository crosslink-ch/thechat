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
import { wsEvents } from "../lib/ws-events";

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

function selfUser() {
  return {
    id: "sender-1",
    name: "Sender",
    email: "sender@example.com",
    avatar: null,
    type: "human" as const,
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

  it("renders sent messages optimistically and replaces the server echo", async () => {
    vi.mocked(api.messages).mockReturnValue({
      get: vi.fn(() => Promise.resolve({ data: [] })),
    } as any);
    const wsSendMessage = vi.fn();

    const { result } = renderHook(
      () =>
        useChannelChat({
          conversationId: "dm-hermes",
          token: "test-token",
          wsSendMessage,
          selfUser: {
            id: "sender-1",
            name: "Sender",
            email: "sender@example.com",
            avatar: null,
            type: "human",
          },
        }),
      { wrapper: createQueryWrapper() },
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      result.current.sendMessage("show this right away");
    });

    expect(wsSendMessage).toHaveBeenCalledWith(
      "dm-hermes",
      "show this right away",
      null,
      expect.any(String),
    );
    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0]).toMatchObject({
      id: expect.stringMatching(/^optimistic:/),
      content: "show this right away",
      senderId: "sender-1",
      senderName: "Sender",
    });

    const persisted = message("dm-hermes", "show this right away");
    const clientMessageId = wsSendMessage.mock.calls[0][3];
    act(() => {
      result.current.addMessage(persisted, clientMessageId);
    });

    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0]).toMatchObject({
      id: persisted.id,
      content: "show this right away",
    });
  });

  it("keeps optimistic sent messages when an in-flight history fetch resolves without them", async () => {
    const history = deferred<{ data: ChatMessage[] }>();
    vi.mocked(api.messages).mockReturnValue({
      get: vi.fn(() => history.promise),
    } as any);

    const { result } = renderHook(
      () =>
        useChannelChat({
          conversationId: "dm-hermes",
          token: "test-token",
          wsSendMessage: vi.fn(),
          selfUser: {
            id: "sender-1",
            name: "Sender",
            email: "sender@example.com",
            avatar: null,
            type: "human",
          },
        }),
      { wrapper: createQueryWrapper() },
    );

    await waitFor(() => expect(api.messages).toHaveBeenCalledTimes(1));

    act(() => {
      result.current.sendMessage("sent during load");
    });

    expect(result.current.messages.map((m) => m.content)).toEqual([
      "sent during load",
    ]);

    act(() => {
      history.resolve({ data: [] });
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.messages.map((m) => m.content)).toEqual([
      "sent during load",
    ]);
  });

  it("keeps a confirmed echo when an older in-flight history fetch omits it", async () => {
    const history = deferred<{ data: ChatMessage[] }>();
    vi.mocked(api.messages).mockReturnValue({
      get: vi.fn(() => history.promise),
    } as any);
    const wsSendMessage = vi.fn();

    const { result } = renderHook(
      () =>
        useChannelChat({
          conversationId: "dm-hermes",
          token: "test-token",
          wsSendMessage,
          selfUser: selfUser(),
        }),
      { wrapper: createQueryWrapper() },
    );

    await waitFor(() => expect(api.messages).toHaveBeenCalledTimes(1));

    act(() => {
      result.current.sendMessage("survive stale history");
    });
    const clientMessageId = wsSendMessage.mock.calls[0][3];
    const persisted = message("dm-hermes", "survive stale history");

    act(() => {
      result.current.addMessage(persisted, clientMessageId);
    });
    expect(result.current.messages.map((item) => item.id)).toEqual([
      persisted.id,
    ]);

    act(() => {
      history.resolve({ data: [] });
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.messages.map((item) => item.id)).toEqual([
      persisted.id,
    ]);
  });

  it("renders a repeated message even when identical content already exists", async () => {
    const previous = message("dm-hermes", "yes");
    vi.mocked(api.messages).mockReturnValue({
      get: vi.fn(() => Promise.resolve({ data: [previous] })),
    } as any);
    const wsSendMessage = vi.fn();

    const { result } = renderHook(
      () =>
        useChannelChat({
          conversationId: "dm-hermes",
          token: "test-token",
          wsSendMessage,
          selfUser: selfUser(),
        }),
      { wrapper: createQueryWrapper() },
    );

    await waitFor(() => expect(result.current.messages).toHaveLength(1));

    act(() => {
      result.current.sendMessage("yes");
    });
    expect(result.current.messages).toHaveLength(2);
    expect(result.current.messages[1].id).toMatch(/^optimistic:/);

    const clientMessageId = wsSendMessage.mock.calls[0][3];
    const persisted = message("dm-hermes", "yes");
    act(() => {
      result.current.addMessage(persisted, clientMessageId);
    });

    expect(result.current.messages.map((item) => item.id)).toEqual([
      previous.id,
      persisted.id,
    ]);
  });

  it("reconciles identical in-flight sends one-to-one", async () => {
    vi.mocked(api.messages).mockReturnValue({
      get: vi.fn(() => Promise.resolve({ data: [] })),
    } as any);
    const wsSendMessage = vi.fn();

    const { result } = renderHook(
      () =>
        useChannelChat({
          conversationId: "dm-hermes",
          token: "test-token",
          wsSendMessage,
          selfUser: selfUser(),
        }),
      { wrapper: createQueryWrapper() },
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => {
      result.current.sendMessage("same");
      result.current.sendMessage("same");
    });
    expect(result.current.messages).toHaveLength(2);

    const first = message("dm-hermes", "same");
    act(() => {
      result.current.addMessage(first, wsSendMessage.mock.calls[0][3]);
    });
    expect(result.current.messages).toHaveLength(2);
    expect(result.current.messages.map((item) => item.id)).toContain(first.id);

    const second = message("dm-hermes", "same");
    act(() => {
      result.current.addMessage(second, wsSendMessage.mock.calls[1][3]);
    });
    expect(result.current.messages.map((item) => item.id)).toEqual([
      first.id,
      second.id,
    ]);
  });

  it("reconciles id-less live echoes one-to-one for older servers", async () => {
    vi.mocked(api.messages).mockReturnValue({
      get: vi.fn(() => Promise.resolve({ data: [] })),
    } as any);

    const { result } = renderHook(
      () =>
        useChannelChat({
          conversationId: "dm-hermes",
          token: "test-token",
          wsSendMessage: vi.fn(),
          selfUser: selfUser(),
        }),
      { wrapper: createQueryWrapper() },
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => {
      result.current.sendMessage("same");
      result.current.sendMessage("same");
    });

    const first = message("dm-hermes", "same");
    act(() => {
      result.current.addMessage(first);
    });
    expect(result.current.messages).toHaveLength(2);
    expect(result.current.messages.filter((item) => item.id === first.id)).toHaveLength(1);

    const second = message("dm-hermes", "same");
    act(() => {
      result.current.addMessage(second);
    });
    expect(result.current.messages.map((item) => item.id)).toEqual([
      first.id,
      second.id,
    ]);
  });

  it("rolls back a rejected optimistic message and exposes the error", async () => {
    vi.mocked(api.messages).mockReturnValue({
      get: vi.fn(() => Promise.resolve({ data: [] })),
    } as any);
    const wsSendMessage = vi.fn();

    const { result } = renderHook(
      () =>
        useChannelChat({
          conversationId: "dm-hermes",
          token: "test-token",
          wsSendMessage,
          selfUser: selfUser(),
        }),
      { wrapper: createQueryWrapper() },
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => {
      result.current.sendMessage("will fail");
    });
    expect(result.current.messages).toHaveLength(1);

    act(() => {
      wsEvents.emit("ws:message_error", {
        conversationId: "dm-hermes",
        clientMessageId: wsSendMessage.mock.calls[0][3],
        message: "Thread not found",
      });
    });

    expect(result.current.messages).toEqual([]);
    expect(result.current.sendError).toBe("Thread not found");

    act(() => {
      result.current.sendMessage("try again");
    });
    expect(result.current.sendError).toBeNull();
    expect(result.current.messages).toHaveLength(1);
  });

  it("can optimistically render sent Hermes task-thread messages", async () => {
    vi.mocked(api.messages).mockReturnValue({
      get: vi.fn(() => Promise.resolve({ data: [] })),
    } as any);

    const { result } = renderHook(
      () =>
        useChannelChat({
          conversationId: "dm-hermes",
          threadId: "thread-1",
          token: "test-token",
          wsSendMessage: vi.fn(),
          selfUser: {
            id: "sender-1",
            name: "Sender",
            email: "sender@example.com",
            avatar: null,
            type: "human",
          },
        }),
      { wrapper: createQueryWrapper() },
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    let clientMessageId: string | null = null;
    act(() => {
      clientMessageId = result.current.addOptimisticSentMessage(
        "thread prompt",
        "thread-1",
      );
    });

    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0]).toMatchObject({
      id: expect.stringMatching(/^optimistic:/),
      threadId: "thread-1",
      content: "thread prompt",
    });

    const persisted = message("dm-hermes", "thread prompt", "thread-1");
    act(() => {
      result.current.addMessage(persisted, clientMessageId!);
    });

    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0].id).toBe(persisted.id);
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

  it("unloads a scope's extra history pages when switching away", async () => {
    const recent = Array.from({ length: MESSAGE_PAGE_SIZE }, (_, i) =>
      message(
        "dm-hermes",
        `recent ${i}`,
        null,
        `2026-01-01T00:${String(20 + i).padStart(2, "0")}:00.000Z`,
      ),
    );
    const older = Array.from({ length: MESSAGE_PAGE_SIZE }, (_, i) =>
      message(
        "dm-hermes",
        `older ${i}`,
        null,
        `2026-01-01T00:${String(i).padStart(2, "0")}:00.000Z`,
      ),
    );
    const get = vi.fn(({ query }: { query: Record<string, unknown> }) =>
      Promise.resolve({
        data: query.threadId
          ? [message("dm-hermes", "task history", "thread-2")]
          : query.before
            ? older
            : recent,
      }),
    );
    vi.mocked(api.messages).mockReturnValue({ get } as any);
    const client = createTestQueryClient();

    const { result, rerender } = renderHook(
      ({ threadId, unthreadedOnly }: { threadId: string | null; unthreadedOnly: boolean }) =>
        useChannelChat({
          conversationId: "dm-hermes",
          threadId,
          unthreadedOnly,
          token: "test-token",
          wsSendMessage: vi.fn(),
        }),
      {
        initialProps: { threadId: null as string | null, unthreadedOnly: true },
        wrapper: createQueryWrapper(client),
      },
    );

    await waitFor(() => {
      expect(result.current.messages).toHaveLength(MESSAGE_PAGE_SIZE);
    });
    await act(async () => {
      await result.current.loadOlderMessages();
    });
    await waitFor(() => {
      expect(result.current.messages).toHaveLength(MESSAGE_PAGE_SIZE * 2);
    });

    rerender({ threadId: "thread-2", unthreadedOnly: false });

    const generalWindow = client.getQueryData<
      InfiniteData<TestMessagePage, string | null>
    >(messagesQueryKey("dm-hermes", null, true));
    expect(flattenWindow(generalWindow)).toEqual(recent.map((m) => m.content));
    expect(generalWindow?.pages).toHaveLength(1);
    expect(generalWindow?.pages[0].hasOlder).toBe(true);

    await waitFor(() => {
      expect(result.current.messages.map((m) => m.content)).toEqual([
        "task history",
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
