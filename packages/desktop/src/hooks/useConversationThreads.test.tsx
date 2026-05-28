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
    const get = vi.fn(() => Promise.resolve({ data: [initial] }));
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
});

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
    createdById: "user-1",
    lastActivityAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}
