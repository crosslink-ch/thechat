import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type {
  ConversationThreadGroupPage,
  ConversationThreadPublic,
  ConversationThreadsPage,
} from "@thechat/shared";
import { api } from "../lib/api";
import { wsEvents } from "../lib/ws-events";
import { createQueryWrapper } from "../test-utils/query";
import { useConversationThreads } from "./useConversationThreads";

vi.mock("../lib/api", () => ({
  api: {
    conversations: {
      threads: vi.fn(),
      "thread-groups": vi.fn(),
    },
  },
}));

const SECURITY = "project-security";

/**
 * A fake server: tasks live in `tasks`, grouped and paged the way the API
 * does it, so the hook runs against real paging rather than canned pages.
 */
function fakeServer(tasks: ConversationThreadPublic[], options: { legacy?: boolean } = {}) {
  const projects = [SECURITY];
  const ordered = () =>
    [...tasks].sort(
      (a, b) =>
        Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt) ||
        (a.id < b.id ? 1 : -1),
    );
  const pageOf = (
    items: ConversationThreadPublic[],
    limit: number,
    cursor?: string,
  ): ConversationThreadsPage & { totalCount: number } => {
    const start = cursor ? items.findIndex((item) => item.id === cursor) + 1 : 0;
    const page = items.slice(start, start + limit);
    const hasMore = start + limit < items.length;
    return {
      items: page.map((item) => ({ ...item })),
      hasMore,
      nextCursor: hasMore ? page.at(-1)!.id : null,
      totalCount: items.length,
    };
  };
  const groupsGet = vi.fn(({ query }: { query: { limit: number } }) => {
    if (options.legacy) {
      return Promise.resolve({ error: { status: 404, value: "NOT_FOUND" } });
    }
    const groups: ConversationThreadGroupPage[] = [...projects, null].map((projectId) => ({
      projectId,
      ...pageOf(
        ordered().filter((task) => (task.projectId ?? null) === projectId),
        query.limit,
      ),
    }));
    return Promise.resolve({ data: { groups } });
  });
  const listGet = vi.fn(
    ({ query }: { query: { limit: number; cursor?: string; projectId?: string } }) => {
      const scoped =
        query.projectId === undefined
          ? ordered()
          : ordered().filter((task) => (task.projectId ?? "none") === query.projectId);
      return Promise.resolve({ data: pageOf(scoped, query.limit, query.cursor) });
    },
  );
  const singleGet = vi.fn((threadId: string) => {
    const task = tasks.find((item) => item.id === threadId);
    return Promise.resolve(
      task
        ? { data: { ...task } }
        : { error: { status: 404, value: { error: "Thread not found" } } },
    );
  });
  const patch = vi.fn((body: { threadId: string; title?: string; projectId?: string | null }) => {
    const task = tasks.find((item) => item.id === body.threadId)!;
    if (body.title !== undefined) task.title = body.title;
    if (body.projectId !== undefined) task.projectId = body.projectId;
    return Promise.resolve({ data: { ...task } });
  });

  vi.mocked(api.conversations["thread-groups"]).mockReturnValue({ get: groupsGet } as any);
  vi.mocked(api.conversations.threads).mockImplementation((() => {
    const scoped = ({ threadId }: { threadId: string }) => ({
      get: () => singleGet(threadId),
      delete: vi.fn(() => Promise.resolve({ data: { ok: true } })),
    });
    return Object.assign(scoped, { get: listGet, post: vi.fn(), patch });
  }) as any);
  return { groupsGet, listGet, singleGet, patch };
}

function task(
  id: string,
  minutesAgo: number,
  projectId: string | null = null,
): ConversationThreadPublic {
  const at = new Date(Date.UTC(2026, 9, 26, 12, 0) - minutesAgo * 60_000).toISOString();
  return {
    id,
    conversationId: "conversation-1",
    botId: "bot-1",
    title: `Task ${id}`,
    status: "active",
    projectId,
    createdById: "user-1",
    lastActivityAt: at,
    createdAt: at,
    updatedAt: at,
  };
}

/** Three recent unfiled tasks and three older Security tasks; pages hold 2. */
function scenario() {
  return [
    task("chore-3", 1),
    task("chore-2", 2),
    task("chore-1", 3),
    task("rotate-keys", 60, SECURITY),
    task("audit-logins", 61, SECURITY),
    task("review-firewall", 62, SECURITY),
  ];
}

function render(options: { activeThreadId?: string | null } = {}) {
  return renderHook(
    (props: { activeThreadId?: string | null }) =>
      useConversationThreads("conversation-1", "test-token", true, {
        pageSize: 2,
        activeThreadId: props.activeThreadId ?? null,
      }),
    { wrapper: createQueryWrapper(), initialProps: options },
  );
}

type HookResult = { current: ReturnType<typeof useConversationThreads> };
const ids = (result: HookResult, projectId: string | null) =>
  result.current.threads
    .filter((thread) => (thread.projectId ?? null) === projectId)
    .map((thread) => thread.id);
const group = (result: HookResult, projectId: string | null) =>
  result.current.groups.find((item) => item.projectId === projectId);

describe("useConversationThreads", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("shows a project's tasks even when newer tasks elsewhere fill a page", async () => {
    const server = fakeServer(scenario());
    const { result } = render();

    // Paging the whole conversation loaded only the 2 newest, unfiled tasks.
    await waitFor(() => expect(ids(result, SECURITY)).toEqual(["rotate-keys", "audit-logins"]));
    expect(server.groupsGet).toHaveBeenCalledWith({
      query: { limit: 2 },
      headers: { authorization: "Bearer test-token" },
    });
    expect(ids(result, null)).toEqual(["chore-3", "chore-2"]);
    expect(group(result, SECURITY)).toMatchObject({ totalCount: 3, hasMore: true });
    expect(group(result, null)).toMatchObject({ totalCount: 3, hasMore: true });
  });

  it("loads more pages of one group without touching the others", async () => {
    const server = fakeServer(scenario());
    const { result } = render();
    await waitFor(() => expect(group(result, SECURITY)?.hasMore).toBe(true));

    await act(async () => {
      await result.current.loadMore(SECURITY);
    });

    expect(server.listGet).toHaveBeenLastCalledWith({
      query: { limit: 2, cursor: "audit-logins", projectId: SECURITY },
      headers: { authorization: "Bearer test-token" },
    });
    expect(ids(result, SECURITY)).toEqual(["rotate-keys", "audit-logins", "review-firewall"]);
    expect(group(result, SECURITY)).toMatchObject({ totalCount: 3, hasMore: false });
    expect(ids(result, null)).toEqual(["chore-3", "chore-2"]);
    expect(group(result, null)?.hasMore).toBe(true);

    await act(async () => {
      await result.current.loadMore(null);
    });
    expect(server.listGet).toHaveBeenLastCalledWith({
      query: { limit: 2, cursor: "chore-2", projectId: "none" },
      headers: { authorization: "Bearer test-token" },
    });
    expect(ids(result, null)).toEqual(["chore-3", "chore-2", "chore-1"]);
  });

  it("opens a task that is on no loaded page instead of dropping it", async () => {
    const server = fakeServer(scenario());
    const { result, rerender } = render({ activeThreadId: "review-firewall" });

    await waitFor(() => expect(ids(result, SECURITY)).toContain("review-firewall"));
    expect(server.singleGet).toHaveBeenCalledWith("review-firewall");
    expect(result.current.activeThreadMissing).toBe(false);
    // The server count already includes the fetched task.
    expect(group(result, SECURITY)?.totalCount).toBe(3);

    rerender({ activeThreadId: "deleted-task" });
    await waitFor(() => expect(result.current.activeThreadMissing).toBe(true));
  });

  it("renames a task in place", async () => {
    const server = fakeServer(scenario());
    const { result } = render();
    await waitFor(() => expect(ids(result, SECURITY)).toContain("rotate-keys"));

    await act(async () => {
      await result.current.renameThread("rotate-keys", "Rotate API keys");
    });

    expect(server.patch).toHaveBeenCalledWith(
      { threadId: "rotate-keys", title: "Rotate API keys" },
      { headers: { authorization: "Bearer test-token" } },
    );
    await waitFor(() =>
      expect(result.current.threads.find((thread) => thread.id === "rotate-keys")).toMatchObject({
        title: "Rotate API keys",
        projectId: SECURITY,
      }),
    );
    expect(group(result, SECURITY)?.totalCount).toBe(3);
  });

  it("keeps group counts exact when a task moves between groups", async () => {
    const server = fakeServer(scenario());
    const { result } = render();
    await waitFor(() => expect(group(result, SECURITY)?.totalCount).toBe(3));

    await act(async () => {
      await result.current.moveThread("chore-3", SECURITY);
    });

    expect(server.patch).toHaveBeenCalledWith(
      { threadId: "chore-3", projectId: SECURITY },
      { headers: { authorization: "Bearer test-token" } },
    );
    await waitFor(() => expect(ids(result, SECURITY)).toContain("chore-3"));
    expect(ids(result, null)).not.toContain("chore-3");
    expect(group(result, SECURITY)?.totalCount).toBe(4);
    expect(group(result, null)?.totalCount).toBe(2);
  });

  it("applies another client's rename and move from websocket events", async () => {
    const server = fakeServer(scenario());
    const { result } = render();
    await waitFor(() => expect(group(result, null)?.totalCount).toBe(3));

    act(() => {
      wsEvents.emit("ws:conversation_thread_updated", {
        conversationId: "conversation-1",
        thread: { ...task("chore-2", 2), title: "Renamed elsewhere", projectId: SECURITY },
      });
    });

    await waitFor(() =>
      expect(result.current.threads.find((thread) => thread.id === "chore-2")).toMatchObject({
        title: "Renamed elsewhere",
        projectId: SECURITY,
      }),
    );
    expect(group(result, SECURITY)?.totalCount).toBe(4);
    expect(group(result, null)?.totalCount).toBe(2);
    expect(server.groupsGet).toHaveBeenCalledTimes(1);
  });

  it("reloads when a message touches a task no group has loaded", async () => {
    const tasks = scenario();
    const server = fakeServer(tasks);
    const { result } = render();
    await waitFor(() => expect(server.groupsGet).toHaveBeenCalledTimes(1));

    // review-firewall is on Security's second page; new activity lifts it.
    tasks.find((item) => item.id === "review-firewall")!.lastActivityAt =
      "2026-10-26T12:30:00.000Z";
    act(() => {
      result.current.touchThread("review-firewall", "2026-10-26T12:30:00.000Z");
    });

    await waitFor(() => expect(ids(result, SECURITY)[0]).toBe("review-firewall"));
    expect(server.groupsGet).toHaveBeenCalledTimes(2);
  });

  it("falls back to the single recency list on a server without task groups", async () => {
    const server = fakeServer(scenario(), { legacy: true });
    const { result } = render();

    await waitFor(() =>
      expect(result.current.threads.map((thread) => thread.id)).toEqual(["chore-3", "chore-2"]),
    );
    expect(server.listGet).toHaveBeenCalledWith({
      query: { limit: 2 },
      headers: { authorization: "Bearer test-token" },
    });
    expect(group(result, null)).toMatchObject({ hasMore: true, totalCount: null });

    await act(async () => {
      await result.current.loadMore(null);
    });
    expect(server.listGet).toHaveBeenLastCalledWith({
      query: { limit: 2, cursor: "chore-2" },
      headers: { authorization: "Bearer test-token" },
    });
    expect(result.current.threads).toHaveLength(4);
  });
});
