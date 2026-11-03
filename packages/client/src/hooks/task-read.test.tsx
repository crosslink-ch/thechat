import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { ChatMessage, TaskMessagePage } from "@thechat/shared";
import { useChannelChat, cacheIncomingMessage, messagesQueryKey, MESSAGE_WINDOW_TRIM_THRESHOLD } from "./useChannelChat";
import { usePersistConversationRead } from "./usePersistConversationRead";
import { createQueryWrapper, createTestQueryClient } from "../test-utils/query";
import { useAuthStore } from "../stores/auth";

import { resetPrivateSession } from "../lib/session-boundary";

const mocks = vi.hoisted(() => ({ page: vi.fn(), ordinary: vi.fn(), read: vi.fn() }));
vi.mock("../lib/api", () => ({ api: {
  messages: ({ conversationId }: { conversationId: string }) => ({
    get: mocks.ordinary,
    "task-page": { get: (options: unknown) => mocks.page(conversationId, options) },
  }),
  activity: {
    conversations: () => ({ read: { post: mocks.read } }),
    get: vi.fn(async () => ({ data: { items: [], totalUnreadMessages: 0 }, error: null })),
  },
} }));

const user = { id: "human", name: "Human", email: "human@test.invalid", avatar: null, type: "human" as const };
const empty = { data: { items: [], totalUnreadMessages: 0 }, error: null };
function message(id: string, threadId: string | null = "task-a"): ChatMessage {
  return { id, threadId, conversationId: "dm", senderId: "bot", senderName: "Bot", content: id, createdAt: "2026-01-01T00:00:00.000Z" };
}
function page(threadId: string | null = "task-a"): TaskMessagePage {
  return {
    messages: Array.from({ length: 20 }, (_, i) => message(`rendered-${threadId}-${i}`, threadId)),
    unreadMessageIds: Array.from({ length: 225 }, (_, i) => `old-${threadId}-${i}`),
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function useTask({ threadId = "task-a", enabled = true }: { threadId?: string | null; enabled?: boolean }) {
  const chat = useChannelChat({
    conversationId: "dm", threadId, unthreadedOnly: threadId === null,
    taskRead: true, enabled, token: useAuthStore.getState().token,
    selfUser: useAuthStore.getState().user, wsSendMessage: vi.fn(),
  });
  usePersistConversationRead("dm", chat.messages, enabled && !chat.loading, {
    threadId, snapshot: chat.taskReadSnapshot,
  });
  return chat;
}
function visibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
  document.dispatchEvent(new Event("visibilitychange"));
}
beforeEach(() => {
  vi.resetAllMocks();
  visibility("visible");
  resetPrivateSession();
  useAuthStore.setState({ token: "token", user });
  mocks.page.mockResolvedValue({ data: page(), error: null });
  mocks.ordinary.mockResolvedValue({ data: page().messages, error: null });
  mocks.read.mockResolvedValue(empty);
});

it("opens the loaded task's old backlog outside the latest 20 in bounded exact-ID batches", async () => {
  const initial = page();
  const unread = new Set([...initial.unreadMessageIds, "sibling", "general", "later-backdated"]);
  mocks.read.mockImplementation(async ({ messageIds }: { messageIds: string[] }) => {
    expect(messageIds.length).toBeLessThanOrEqual(200);
    messageIds.forEach((id) => unread.delete(id));
    return empty;
  });
  renderHook(() => useTask({}), { wrapper: createQueryWrapper() });
  await waitFor(() => expect([...unread]).toEqual(["sibling", "general", "later-backdated"]));
  expect(mocks.page).toHaveBeenCalledWith("dm", expect.objectContaining({ query: { limit: 20, threadId: "task-a" } }));
  expect(mocks.ordinary).not.toHaveBeenCalled();
  expect(mocks.read.mock.calls.map(([body]) => body.messageIds.length)).toEqual([200, 45]);
  expect(mocks.read.mock.calls.every(([body]) => body.threadId === "task-a" && !("all" in body))).toBe(true);
});

it("waits for a visible, successfully loaded view rather than loading or draft state", async () => {
  const response = deferred<{ data: TaskMessagePage; error: null }>();
  mocks.page.mockReturnValue(response.promise);
  const { result, rerender } = renderHook(useTask, { initialProps: { enabled: false }, wrapper: createQueryWrapper() });
  expect(mocks.page).not.toHaveBeenCalled();
  expect(mocks.read).not.toHaveBeenCalled();
  rerender({ enabled: true });
  await waitFor(() => expect(mocks.page).toHaveBeenCalledTimes(1));
  expect(mocks.read).not.toHaveBeenCalled();
  act(() => visibility("hidden"));
  await act(async () => response.resolve({ data: page(), error: null }));
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(mocks.read).not.toHaveBeenCalled();
  act(() => visibility("visible"));
  await waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(2));
});

it("does not initiate a read from a failed message load", async () => {
  mocks.page.mockResolvedValue({ data: null, error: { value: { error: "Load failed" } } });
  mocks.ordinary.mockResolvedValue({ data: null, error: { value: { error: "Load failed" } } });
  const { result } = renderHook(() => useTask({}), { wrapper: createQueryWrapper() });
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(mocks.read).not.toHaveBeenCalled();
});

it.each(["navigation", "draft", "account"])("does not initiate an old response after %s", async (boundary) => {
  const response = deferred<{ data: TaskMessagePage; error: null }>();
  mocks.page.mockReturnValue(response.promise);
  const { rerender } = renderHook(useTask, { initialProps: { threadId: "task-a", enabled: true }, wrapper: createQueryWrapper() });
  await waitFor(() => expect(mocks.page).toHaveBeenCalledTimes(1));
  if (boundary === "account") {
    resetPrivateSession();
    useAuthStore.setState({ token: "other-token", user: { ...user, id: "other-user" } });
    rerender({ threadId: "task-a", enabled: true });
  } else {
    mocks.page.mockReturnValue(new Promise(() => {}));
    rerender({ threadId: boundary === "navigation" ? "task-b" : "task-a", enabled: boundary !== "draft" });
  }
  await act(async () => response.resolve({ data: page(), error: null }));
  expect(mocks.read).not.toHaveBeenCalled();
});

it("finishes a fixed snapshot after leaving, without picking up later messages", async () => {
  const firstBatch = deferred<typeof empty>();
  mocks.read.mockReturnValueOnce(firstBatch.promise);
  const { unmount } = renderHook(() => useTask({}), { wrapper: createQueryWrapper() });
  await waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(1));
  unmount();
  await act(async () => firstBatch.resolve(empty));
  await waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(2));
  expect(mocks.read.mock.calls.flatMap(([body]) => body.messageIds)).toEqual([
    ...page().unreadMessageIds, ...page().messages.map((m) => m.id),
  ]);
});

it("retains General snapshot metadata when realtime trims the cache before the view becomes visible", async () => {
  visibility("hidden");
  mocks.page.mockResolvedValue({ data: page(null), error: null });
  const client = createTestQueryClient();
  const { result } = renderHook(() => useTask({ threadId: null }), { wrapper: createQueryWrapper(client) });
  await waitFor(() => expect(result.current.loading).toBe(false));
  act(() => {
    for (let i = 0; i <= MESSAGE_WINDOW_TRIM_THRESHOLD; i++) cacheIncomingMessage(client, message(`live-${i}`, null));
  });
  expect(client.getQueryData(messagesQueryKey("dm", null, true))).toBeDefined();
  expect(mocks.read).not.toHaveBeenCalled();
  act(() => visibility("visible"));
  await waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(2));
  expect(mocks.read.mock.calls.flatMap(([body]) => body.messageIds)).toEqual(expect.arrayContaining(page(null).unreadMessageIds));
  expect(mocks.read.mock.calls.every(([body]) => body.threadId === null)).toBe(true);
});

it("does not expand an opened backlog on refetch, but still acknowledges rendered live replies", async () => {
  const { result } = renderHook(() => useTask({}), { wrapper: createQueryWrapper() });
  await waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(2));
  mocks.read.mockClear();
  mocks.page.mockResolvedValue({ data: { ...page(), unreadMessageIds: ["late-unrendered-backdated"] }, error: null });
  act(() => result.current.refetchMessages());
  await waitFor(() => expect(mocks.page).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(mocks.read).toHaveBeenCalled());
  expect(mocks.read.mock.calls.flatMap(([body]) => body.messageIds)).not.toContain("late-unrendered-backdated");
  act(() => result.current.addMessage(message("visible-live")));
  await waitFor(() => expect(mocks.read.mock.calls.flatMap(([body]) => body.messageIds)).toContain("visible-live"));
});

it("retries only the original opening backlog after a failed batch and a newer refetch", async () => {
  const initial = page();
  const unread = new Set(initial.unreadMessageIds);
  let calls = 0;
  mocks.read.mockImplementation(async ({ messageIds }: { messageIds: string[] }) => {
    if (++calls === 2) return { data: null, error: { value: { error: "Read failed" } } };
    messageIds.forEach((id) => unread.delete(id));
    return empty;
  });
  const { result } = renderHook(() => useTask({}), { wrapper: createQueryWrapper() });
  await waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(2));
  await act(async () => {});
  expect(unread.size).toBeGreaterThan(0);
  unread.add("late-unrendered-backdated");
  mocks.page.mockResolvedValue({ data: { ...initial, unreadMessageIds: [...unread] }, error: null });
  act(() => result.current.refetchMessages());
  await waitFor(() => expect(mocks.page).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(mocks.read.mock.calls.length).toBeGreaterThan(2));
  await waitFor(() => expect([...unread]).toEqual(["late-unrendered-backdated"]));
  expect(mocks.read.mock.calls.flatMap(([body]) => body.messageIds)).not.toContain("late-unrendered-backdated");
  act(() => result.current.addMessage(message("visible-live")));
  await waitFor(() => expect(mocks.read.mock.calls.flatMap(([body]) => body.messageIds)).toContain("visible-live"));
});

it("does not expand an initially empty task's opening snapshot on a later refetch", async () => {
  mocks.page.mockResolvedValue({ data: { messages: [], unreadMessageIds: [] }, error: null });
  const { result } = renderHook(() => useTask({}), { wrapper: createQueryWrapper() });
  await waitFor(() => expect(result.current.taskReadSnapshot).not.toBeNull());
  expect(mocks.read).not.toHaveBeenCalled();
  mocks.page.mockResolvedValue({ data: { ...page(), unreadMessageIds: ["late-outside-page"] }, error: null });
  act(() => result.current.refetchMessages());
  await waitFor(() => expect(mocks.read).toHaveBeenCalled());
  expect(mocks.read.mock.calls.flatMap(([body]) => body.messageIds)).not.toContain("late-outside-page");
});

it("captures a fresh General backlog after returning from a disabled draft view", async () => {
  mocks.page.mockResolvedValue({ data: page(null), error: null });
  const { rerender } = renderHook(useTask, {
    initialProps: { threadId: null, enabled: true }, wrapper: createQueryWrapper(),
  });
  await waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(2));
  mocks.read.mockClear();
  rerender({ threadId: null, enabled: false });
  expect(mocks.read).not.toHaveBeenCalled();
  mocks.page.mockResolvedValue({ data: { ...page(null), unreadMessageIds: ["arrived-during-draft"] }, error: null });
  rerender({ threadId: null, enabled: true });
  await waitFor(() => expect(mocks.read.mock.calls.flatMap(([body]) => body.messageIds)).toContain("arrived-during-draft"));
});

it("fetches a new backlog on returning to a task even when its cache is recent", async () => {
  const { rerender } = renderHook(useTask, { initialProps: { threadId: "task-a" }, wrapper: createQueryWrapper() });
  await waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(2));
  mocks.page.mockResolvedValue({ data: page("task-b"), error: null });
  rerender({ threadId: "task-b" });
  await waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(4));
  mocks.page.mockResolvedValue({ data: { ...page(), unreadMessageIds: ["while-away"] }, error: null });
  rerender({ threadId: "task-a" });
  await waitFor(() => expect(mocks.read.mock.calls.flatMap(([body]) => body.messageIds)).toContain("while-away"));
});
