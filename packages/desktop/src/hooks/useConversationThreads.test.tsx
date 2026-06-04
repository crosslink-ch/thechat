import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ConversationThreadPublic } from "@thechat/shared";
import { api } from "../lib/api";
import { createQueryWrapper } from "../test-utils/query";
import { useConversationThreads } from "./useConversationThreads";

vi.mock("../lib/api", () => ({
  api: {
    conversations: {
      threads: vi.fn(),
    },
  },
}));

describe("useConversationThreads", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("renames a default task thread in the cache", async () => {
    const initial = thread({ title: "New task" });
    const updated = thread({ title: "Summarize build logs" });
    const get = vi.fn(() =>
      Promise.resolve({ data: page([initial]) }),
    );
    const patch = vi.fn(() => Promise.resolve({ data: updated }));
    vi.mocked(api.conversations.threads).mockReturnValue({
      get,
      post: vi.fn(),
      patch,
    } as any);

    const { result } = renderHook(
      () => useConversationThreads("conversation-1", "test-token", true),
      { wrapper: createQueryWrapper() },
    );

    await waitFor(() => {
      expect(result.current.threads.map((item) => item.title)).toEqual(["New task"]);
    });
    expect(get).toHaveBeenCalledWith({
      query: { limit: 50 },
      headers: { authorization: "Bearer test-token" },
    });

    await act(async () => {
      await result.current.renameThread("thread-1", "Summarize build logs");
    });

    expect(patch).toHaveBeenCalledWith(
      { threadId: "thread-1", title: "Summarize build logs" },
      { headers: { authorization: "Bearer test-token" } },
    );
    await waitFor(() => {
      expect(result.current.threads.map((item) => item.title)).toEqual([
        "Summarize build logs",
      ]);
    });
  });

  it("loads additional task pages with the returned cursor", async () => {
    const first = thread({ id: "thread-1", title: "First page" });
    const second = thread({ id: "thread-2", title: "Second page" });
    const get = vi.fn(({ query }: { query: { cursor?: string } }) =>
      Promise.resolve({
        data: query.cursor === "next-page"
          ? page([second])
          : page([first], { nextCursor: "next-page", hasMore: true }),
      }),
    );
    vi.mocked(api.conversations.threads).mockReturnValue({
      get,
      post: vi.fn(),
      patch: vi.fn(),
    } as any);

    const { result } = renderHook(
      () => useConversationThreads("conversation-1", "test-token", true),
      { wrapper: createQueryWrapper() },
    );

    await waitFor(() => {
      expect(result.current.threads.map((item) => item.title)).toEqual([
        "First page",
      ]);
    });
    expect(result.current.hasMore).toBe(true);

    await act(async () => {
      await result.current.loadMore();
    });

    await waitFor(() => {
      expect(result.current.threads.map((item) => item.title)).toEqual([
        "First page",
        "Second page",
      ]);
    });
    expect(get).toHaveBeenLastCalledWith({
      query: { limit: 50, cursor: "next-page" },
      headers: { authorization: "Bearer test-token" },
    });
    expect(result.current.hasMore).toBe(false);
  });

  it("refetches when a message touches a thread outside the loaded pages", async () => {
    const visible = thread({ id: "thread-1", title: "Visible thread" });
    const promoted = thread({
      id: "thread-2",
      title: "Promoted old thread",
      lastActivityAt: "2026-01-02T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
    let fetchCount = 0;
    const get = vi.fn(() => {
      fetchCount += 1;
      return Promise.resolve({
        data: fetchCount === 1 ? page([visible]) : page([promoted, visible]),
      });
    });
    vi.mocked(api.conversations.threads).mockReturnValue({
      get,
      post: vi.fn(),
      patch: vi.fn(),
    } as any);

    const { result } = renderHook(
      () => useConversationThreads("conversation-1", "test-token", true),
      { wrapper: createQueryWrapper() },
    );

    await waitFor(() => {
      expect(result.current.threads.map((item) => item.title)).toEqual([
        "Visible thread",
      ]);
    });

    act(() => {
      result.current.touchThread("thread-2", "2026-01-02T00:00:00.000Z");
    });

    await waitFor(() => {
      expect(result.current.threads.map((item) => item.title)).toEqual([
        "Promoted old thread",
        "Visible thread",
      ]);
    });
    expect(get).toHaveBeenCalledTimes(2);
  });
});

function page(
  items: ConversationThreadPublic[],
  overrides: { nextCursor?: string | null; hasMore?: boolean } = {},
) {
  return {
    items,
    nextCursor: overrides.nextCursor ?? null,
    hasMore: overrides.hasMore ?? false,
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
    title: "New task",
    status: "active",
    hermesSession: null,
    createdById: "user-1",
    lastActivityAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}
