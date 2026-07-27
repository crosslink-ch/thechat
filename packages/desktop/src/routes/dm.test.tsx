import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createThread: vi.fn(),
  renameThread: vi.fn(),
  touchThread: vi.fn(),
  addOptimisticSentMessage: vi.fn(() => "client-message-1"),
  sendChannelMessage: vi.fn(),
  wsSendMessage: vi.fn(),
  sendTyping: vi.fn(),
  closePaletteAndRefocus: vi.fn(),
}));

vi.mock("../stores/auth", () => ({
  useAuthStore: (selector: (state: unknown) => unknown) =>
    selector({
      token: "token-1",
      user: { id: "user-1", name: "Human", type: "human" },
    }),
}));

vi.mock("../stores/workspaces", () => {
  const state = {
    activeWorkspace: {
      members: [],
    },
  };
  const store = (selector: (value: typeof state) => unknown) => selector(state);
  store.getState = () => ({ touchThread: mocks.touchThread });
  return { useWorkspacesStore: store };
});

vi.mock("../stores/websocket", () => ({
  useWebSocketStore: (selector: (state: unknown) => unknown) =>
    selector({
      sendMessage: mocks.wsSendMessage,
      sendTyping: mocks.sendTyping,
    }),
}));

vi.mock("../hooks/useConversationDetail", () => ({
  useConversationDetail: () => ({
    data: {
      id: "dm-1",
      type: "direct",
      participants: [
        {
          userId: "user-1",
          user: { id: "user-1", name: "Human", type: "human" },
        },
        {
          userId: "bot-user-1",
          user: { id: "bot-user-1", name: "Hermes", type: "bot" },
          bot: { id: "bot-1", kind: "hermes", commands: [] },
        },
      ],
    },
    isLoading: false,
    error: null,
  }),
}));

vi.mock("../hooks/useConversationThreads", () => ({
  useConversationThreads: () => ({
    threads: [],
    loading: false,
    loadingMore: false,
    hasMore: false,
    loadMore: vi.fn(),
    createThread: mocks.createThread,
    renameThread: mocks.renameThread,
    touchThread: mocks.touchThread,
  }),
}));

vi.mock("../hooks/useBotRuntime", () => ({
  useBotRuntime: () => ({
    data: { invocations: [], events: [] },
    isLoading: false,
  }),
  useBotRuntimeCache: () => ({
    mergeInvocationUpdate: vi.fn(),
    mergeProgressEvent: vi.fn(),
  }),
}));

vi.mock("../hooks/useChannelChat", () => ({
  useChannelChat: () => ({
    messages: [],
    loading: false,
    loadingOlder: false,
    hasOlderMessages: false,
    sendError: null,
    sendMessage: mocks.sendChannelMessage,
    sendTyping: mocks.sendTyping,
    addMessage: vi.fn(),
    addOptimisticSentMessage: mocks.addOptimisticSentMessage,
    loadOlderMessages: vi.fn(),
  }),
}));

vi.mock("../hooks/useScopedCommands", () => ({
  useScopedCommands: vi.fn(),
}));

vi.mock("../stores/hermes-indicators", () => {
  const state = {
    pendingApprovals: [],
    unreadScopes: {},
    setVisibleScope: vi.fn(),
    seedFromSnapshot: vi.fn(),
  };
  const store = (selector: (value: typeof state) => unknown) => selector(state);
  store.getState = () => state;
  return {
    hermesScopeKey: (conversationId: string, threadId: string | null) =>
      `${conversationId}:${threadId ?? "general"}`,
    useHermesIndicatorsStore: store,
  };
});

vi.mock("../stores/hermes-approvals", () => {
  const state = { decisions: {} };
  const store = (selector: (value: typeof state) => unknown) => selector(state);
  store.getState = () => state;
  return {
    recordApprovalDecision: vi.fn(),
    useHermesApprovalsStore: store,
  };
});

vi.mock("../CommandPalette", () => ({
  closePaletteAndRefocus: mocks.closePaletteAndRefocus,
}));

vi.mock("../components/ChannelChatView", () => ({
  ChannelChatView: () => <div data-testid="channel-chat" />,
}));

vi.mock("../components/HermesDmChatView", () => ({
  HermesDmChatView: ({ onSend, messages, sendError }: any) => (
    <div data-testid="hermes-chat" data-message-count={messages.length}>
      <button type="button" onClick={() => onSend("First task prompt")}>Send first prompt</button>
      <button type="button" onClick={() => onSend("   ")}>Send empty prompt</button>
      {sendError ? <div role="alert">{sendError}</div> : null}
    </div>
  ),
}));

vi.mock("../components/HermesRuntimePanel", () => ({
  HermesRuntimePanel: ({ onCreateThread, draftTaskActive, onSelectThread }: any) => (
    <aside>
      <button type="button" onClick={onCreateThread}>New task</button>
      <button type="button" onClick={() => onSelectThread(null)}>General</button>
      {draftTaskActive ? <div data-testid="local-task-draft">New task draft</div> : null}
    </aside>
  ),
}));

import { DmRoute } from "./dm";

const persistedThread = {
  id: "thread-1",
  title: "First task prompt",
  conversationId: "dm-1",
  botId: "bot-1",
  status: "open",
  createdAt: "2026-07-27T00:00:00.000Z",
  updatedAt: "2026-07-27T00:00:00.000Z",
  lastActivityAt: "2026-07-27T00:00:00.000Z",
};

async function renderRoute() {
  const rootRoute = createRootRoute();
  const dmRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/dm/$id",
    component: DmRoute,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([dmRoute]),
    history: createMemoryHistory({ initialEntries: ["/dm/dm-1"] }),
  });

  await act(async () => {
    render(<RouterProvider router={router as any} />);
  });
  return router;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createThread.mockResolvedValue(persistedThread);
  mocks.addOptimisticSentMessage.mockReturnValue("client-message-1");
});

describe("DmRoute deferred Hermes task drafts", () => {
  it("keeps New task client-only until the first prompt is sent", async () => {
    await renderRoute();

    fireEvent.click(screen.getByRole("button", { name: "New task" }));

    expect(mocks.createThread).not.toHaveBeenCalled();
    expect(screen.getByTestId("local-task-draft")).toBeInTheDocument();
    expect(screen.getByTestId("hermes-chat")).toHaveAttribute("data-message-count", "0");

    fireEvent.click(screen.getByRole("button", { name: "Send first prompt" }));

    await waitFor(() => {
      expect(mocks.createThread).toHaveBeenCalledWith({
        botId: "bot-1",
        title: "First task prompt",
      });
    });
    expect(mocks.addOptimisticSentMessage).toHaveBeenCalledWith(
      "First task prompt",
      "thread-1",
    );
    expect(mocks.wsSendMessage).toHaveBeenCalledWith(
      "dm-1",
      "First task prompt",
      "thread-1",
      "client-message-1",
    );
    expect(mocks.touchThread).toHaveBeenCalledWith("thread-1");
  });

  it("does not persist an empty first prompt", async () => {
    await renderRoute();

    fireEvent.click(screen.getByRole("button", { name: "New task" }));
    fireEvent.click(screen.getByRole("button", { name: "Send empty prompt" }));

    expect(mocks.createThread).not.toHaveBeenCalled();
    expect(mocks.addOptimisticSentMessage).not.toHaveBeenCalled();
    expect(mocks.wsSendMessage).not.toHaveBeenCalled();
    expect(screen.getByTestId("local-task-draft")).toBeInTheDocument();
  });

  it("persists a rapid double-submit only once", async () => {
    let resolveThread!: (value: typeof persistedThread) => void;
    mocks.createThread.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveThread = resolve;
      }),
    );
    await renderRoute();

    fireEvent.click(screen.getByRole("button", { name: "New task" }));
    const send = screen.getByRole("button", { name: "Send first prompt" });
    fireEvent.click(send);
    fireEvent.click(send);

    expect(mocks.createThread).toHaveBeenCalledTimes(1);
    resolveThread(persistedThread);
    await waitFor(() => expect(mocks.wsSendMessage).toHaveBeenCalledTimes(1));
  });

  it("does not select a stale task after the visible DM changes", async () => {
    let resolveThread!: (value: typeof persistedThread) => void;
    mocks.createThread.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveThread = resolve;
      }),
    );
    const router = await renderRoute();

    fireEvent.click(screen.getByRole("button", { name: "New task" }));
    fireEvent.click(screen.getByRole("button", { name: "Send first prompt" }));
    await act(async () => {
      await router.navigate({ to: "/dm/$id", params: { id: "dm-2" } });
    });
    fireEvent.click(screen.getByRole("button", { name: "New task" }));
    expect(screen.getByTestId("local-task-draft")).toBeInTheDocument();

    resolveThread(persistedThread);
    await waitFor(() =>
      expect(mocks.wsSendMessage).toHaveBeenCalledWith(
        "dm-1",
        "First task prompt",
        "thread-1",
        undefined,
      ),
    );
    expect(mocks.addOptimisticSentMessage).not.toHaveBeenCalled();
    expect(screen.getByTestId("local-task-draft")).toBeInTheDocument();
  });

  it("keeps the local draft available when thread creation returns no task", async () => {
    mocks.createThread.mockResolvedValueOnce(null);
    await renderRoute();

    fireEvent.click(screen.getByRole("button", { name: "New task" }));
    fireEvent.click(screen.getByRole("button", { name: "Send first prompt" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not create the task. Try again.",
    );
    expect(screen.getByTestId("local-task-draft")).toBeInTheDocument();
    expect(mocks.wsSendMessage).not.toHaveBeenCalled();
  });

  it("keeps the local draft available when first-message persistence fails", async () => {
    mocks.createThread.mockRejectedValueOnce(new Error("API unavailable"));
    await renderRoute();

    fireEvent.click(screen.getByRole("button", { name: "New task" }));
    fireEvent.click(screen.getByRole("button", { name: "Send first prompt" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not create the task. Try again.",
    );
    expect(screen.getByTestId("local-task-draft")).toBeInTheDocument();
    expect(mocks.wsSendMessage).not.toHaveBeenCalled();
    expect(mocks.touchThread).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Send first prompt" }));
    await waitFor(() => expect(mocks.wsSendMessage).toHaveBeenCalledTimes(1));
    expect(mocks.createThread).toHaveBeenCalledTimes(2);
    expect(mocks.addOptimisticSentMessage).toHaveBeenCalledTimes(1);
  });
});
