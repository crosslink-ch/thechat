import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { beforeEach, expect, it, vi } from "vitest";
import type { ActivitySnapshot, BotInvocationPublic, ChatMessage, ConversationThreadPublic } from "@thechat/shared";
import type { TaskReadSnapshot } from "../hooks/useChannelChat";
import { sessionGeneration } from "../lib/session-boundary";

const mocks = vi.hoisted(() => ({
  activityGet: vi.fn(),
  readPost: vi.fn(),
  messages: [] as ChatMessage[],
  threads: [] as ConversationThreadPublic[],
  snapshots: {} as Record<string, TaskReadSnapshot>,
}));
vi.mock("../lib/api", () => ({ API_URL: "http://localhost:3000", api: { activity: {
  get: mocks.activityGet,
  conversations: () => ({ read: { post: mocks.readPost } }),
} } }));
vi.mock("../hooks/useConversationDetail", () => ({ useConversationDetail: () => ({
  data: { id: "dm-1", type: "direct", participants: [
    { userId: "human", user: { id: "human", name: "Human", type: "human" } },
    { userId: "bot-user", user: { id: "bot-user", name: "Hermes", type: "bot" }, bot: { id: "bot", kind: "hermes", commands: [] } },
  ] }, isLoading: false, error: null,
}) }));
vi.mock("../hooks/useConversationThreads", () => ({ useConversationThreads: () => ({
  threads: mocks.threads, groups: [], loading: false, activeThreadMissing: false,
}) }));
vi.mock("../hooks/useTaskProjects", () => ({ useTaskProjects: () => ({ projects: [] }) }));
vi.mock("../hooks/useBotRuntime", () => ({
  useBotRuntime: () => ({ data: null, isLoading: false }),
  useBotRuntimeCache: () => ({}),
}));
vi.mock("../hooks/useChannelChat", () => ({ useChannelChat: ({ threadId, taskRead }: { threadId: string | null; taskRead?: boolean }) => ({
  messages: mocks.messages.filter((message) => message.threadId === threadId), loading: false,
  taskReadSnapshot: taskRead ? mocks.snapshots[threadId ?? "general"] : null,
}) }));
vi.mock("../components/HermesDmChatView", () => ({ HermesDmChatView: ({ messages }: { messages: ChatMessage[] }) => (
  <div>{messages.map((message) => <p key={message.id}>{message.content}</p>)}</div>
) }));
vi.mock("../hooks/useScopedCommands", () => ({ useScopedCommands: vi.fn() }));
vi.mock("../CommandPalette", () => ({ closePalette: vi.fn(), closePaletteAndRefocus: vi.fn() }));

import { DmRoute } from "./dm";
import { useAuthStore } from "../stores/auth";
import { useActivityStore } from "../stores/activity";
import { useHermesIndicatorsStore } from "../stores/hermes-indicators";

const at = "2026-11-01T10:00:00.000Z";
const snapshot: ActivitySnapshot = {
  totalUnreadMessages: 3,
  items: [{
    conversationId: "dm-1", conversationType: "direct", conversationName: "Hermes",
    workspaceId: "workspace-1", workspaceName: "Workspace", unreadCount: 3,
    unreadThreadIds: ["task-a", "task-b", null],
    latestMessage: { id: "message-a", threadId: "task-a", threadTitle: "Task A", senderId: "bot-user",
      senderName: "Hermes", senderType: "bot", content: "Task A result", createdAt: at },
  }],
};

async function openDm() {
  const root = createRootRoute();
  const route = createRoute({ getParentRoute: () => root, path: "/dm/$id",
    validateSearch: (search: Record<string, unknown>) => ({ threadId: typeof search.threadId === "string" ? search.threadId : undefined }),
    component: DmRoute,
  });
  const router = createRouter({ routeTree: root.addChildren([route]), history: createMemoryHistory({ initialEntries: ["/dm/dm-1?threadId=read-task"] }) });
  await act(async () => { render(<RouterProvider router={router as any} />); });
}

function unread(name: string) {
  return within(screen.getByRole("button", { name: new RegExp(`^${name}`) })).queryByLabelText("Unread");
}

function completedTask(threadId: string, conversationId = "dm-1"): BotInvocationPublic {
  return {
    id: `invocation-${conversationId}-${threadId}`, threadId, conversationId, botId: "bot", botUserId: "bot-user", botName: "Hermes", botKind: "hermes",
    triggerMessageId: "trigger", responseMessageId: null, adapterKind: "hermes", status: "completed",
    externalRunId: null, requestJson: null, responseJson: { silent: true }, error: null, startedAt: at, completedAt: at,
    createdAt: at, updatedAt: at,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useAuthStore.setState({ token: "token", user: { id: "human", name: "Human", email: "human@example.invalid", avatar: null, type: "human" } });
  useActivityStore.getState().reset();
  useHermesIndicatorsStore.getState().resetForTests();
  mocks.messages = [];
  mocks.snapshots = Object.fromEntries(["task-a", "task-b", "read-task", "general"].map((key) => [key, {
    conversationId: "dm-1", threadId: key === "general" ? null : key, messageIds: [],
    token: "token", userId: "human", generation: sessionGeneration(),
  }]));
  mocks.threads = [["task-a", "Task A"], ["task-b", "Task B"], ["read-task", "Read task"]].map(([id, title]) => ({
    id, title, conversationId: "dm-1", botId: "bot", status: "open", createdById: "human", createdAt: at, updatedAt: at, lastActivityAt: at,
  }));
  mocks.activityGet.mockResolvedValue({ data: snapshot, error: null });
});

it("restores all task and General dots from Activity with a fresh indicator store, then reads only rendered IDs", async () => {
  await useActivityStore.getState().fetchActivity();
  await openDm();
  expect(useHermesIndicatorsStore.getState().unreadScopes).toEqual({});
  expect(unread("Task A")).toBeInTheDocument();
  expect(unread("Task B")).toBeInTheDocument();
  expect(unread("General")).toBeInTheDocument();

  mocks.messages = [{ ...snapshot.items[0].latestMessage, conversationId: "dm-1", content: "Task A result" }];
  mocks.readPost.mockResolvedValue({ data: {
    ...snapshot, totalUnreadMessages: 2,
    items: [{ ...snapshot.items[0], unreadCount: 2, unreadThreadIds: ["task-b", null] }],
  }, error: null });
  fireEvent.click(screen.getByRole("button", { name: /^Task A/ }));
  await waitFor(() => expect(mocks.readPost).toHaveBeenCalledWith(
    { messageIds: ["message-a"], threadId: "task-a" }, { headers: { authorization: "Bearer token" } },
  ));
  await waitFor(() => expect(useActivityStore.getState().totalUnreadMessages).toBe(2));
  fireEvent.click(screen.getByRole("button", { name: /^Read task/ }));
  expect(unread("Task A")).not.toBeInTheDocument();
  expect(unread("Task B")).toBeInTheDocument();
  expect(unread("General")).toBeInTheDocument();
});

it("acknowledges a task's captured old backlog when its newest page is already read", async () => {
  await useActivityStore.getState().fetchActivity();
  await openDm();
  mocks.messages = [{ ...snapshot.items[0].latestMessage, conversationId: "dm-1", id: "already-read-latest" }];
  mocks.snapshots["task-a"].messageIds = ["old-unread-outside-page"];
  mocks.readPost.mockResolvedValue({ data: {
    ...snapshot, totalUnreadMessages: 2,
    items: [{ ...snapshot.items[0], unreadCount: 2, unreadThreadIds: ["task-b", null] }],
  }, error: null });
  fireEvent.click(screen.getByRole("button", { name: /^Task A/ }));
  await waitFor(() => expect(mocks.readPost).toHaveBeenCalledWith(
    { messageIds: ["old-unread-outside-page", "already-read-latest"], threadId: "task-a" },
    { headers: { authorization: "Bearer token" } },
  ));
  fireEvent.click(screen.getByRole("button", { name: /^Read task/ }));
  expect(unread("Task A")).not.toBeInTheDocument();
  expect(unread("Task B")).toBeInTheDocument();
  expect(unread("General")).toBeInTheDocument();
});

it("restores branch-menu unread markers from Activity and clears them when the branch is read", async () => {
  const user = userEvent.setup();
  mocks.threads = mocks.threads.map((thread) => thread.id === "task-a"
    ? { ...thread, branchFromThreadId: "read-task", branchPending: true }
    : thread);
  await useActivityStore.getState().fetchActivity();
  await openDm();
  expect(useHermesIndicatorsStore.getState().unreadScopes).toEqual({});
  const bar = screen.getByRole("navigation", { name: "Task branches" });
  await user.click(within(bar).getByRole("button", { name: "1 branch from this task, unread branches" }));
  expect(within(screen.getByRole("menuitem", { name: /^Task A/ })).getByLabelText("Unread")).toBeInTheDocument();

  await act(async () => {
    useActivityStore.setState({ items: [{ ...snapshot.items[0], unreadThreadIds: ["task-b", null] }], totalUnreadMessages: 2 });
  });
  expect(within(screen.getByRole("menuitem", { name: "Task A" })).queryByLabelText("Unread")).not.toBeInTheDocument();
  await user.keyboard("{Escape}");
  expect(within(bar).getByRole("button", { name: "1 branch from this task" })).toBeInTheDocument();
  expect(unread("Task B")).toBeInTheDocument();
});

it.each(["task-a", null])("uses the latest scope as a fallback for older Activity servers (%s)", async (threadId) => {
  mocks.activityGet.mockResolvedValue({ data: {
    ...snapshot, items: [{ ...snapshot.items[0], unreadThreadIds: undefined,
      latestMessage: { ...snapshot.items[0].latestMessage, threadId } }],
  }, error: null });
  await useActivityStore.getState().fetchActivity();
  await openDm();
  expect(Boolean(unread("Task A"))).toBe(threadId === "task-a");
  expect(Boolean(unread("General"))).toBe(threadId === null);
  expect(unread("Task B")).not.toBeInTheDocument();
});

it("keeps session-local silent completion dots while durable activity changes without replaying historical completions", async () => {
  const completed = completedTask("task-b");
  useHermesIndicatorsStore.getState().trackInvocation({ ...completed, status: "queued" });
  useHermesIndicatorsStore.getState().trackInvocation(completed);
  // A completed runtime snapshot must not resurrect task A in a fresh client.
  useHermesIndicatorsStore.getState().seedFromSnapshot({ invocations: [completedTask("task-a")], events: [] });
  const other = completedTask("task-a", "other-dm");
  useHermesIndicatorsStore.getState().trackInvocation({ ...other, status: "queued" });
  useHermesIndicatorsStore.getState().trackInvocation(other);
  mocks.activityGet.mockResolvedValue({ data: {
    ...snapshot, items: [
      { ...snapshot.items[0], unreadThreadIds: [] },
      { ...snapshot.items[0], conversationId: "other-dm", unreadThreadIds: ["task-a", null] },
    ],
  }, error: null });
  await useActivityStore.getState().fetchActivity();
  await openDm();
  expect(unread("Task A")).not.toBeInTheDocument();
  expect(unread("Task B")).toBeInTheDocument();
  expect(unread("General")).not.toBeInTheDocument();
  await act(async () => { useActivityStore.setState({ items: [], totalUnreadMessages: 0 }); });
  expect(unread("Task B")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /^Task B/ }));
  fireEvent.click(screen.getByRole("button", { name: /^Read task/ }));
  expect(unread("Task B")).not.toBeInTheDocument();
});
