import { invoke } from "@tauri-apps/api/core";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useCommandsStore } from "../commands";
import { useKeybindings } from "../hooks/useKeybindings";
import { useAuthStore } from "../stores/auth";
import { useHermesApprovalsStore } from "../stores/hermes-approvals";
import { useHermesIndicatorsStore } from "../stores/hermes-indicators";
import {
  scopeNeedsAttention,
  useNeedsAttentionStore,
} from "../stores/needs-attention";
import { useWebSocketStore } from "../stores/websocket";
import { useWorkspacesStore } from "../stores/workspaces";
import { DmRoute } from "./dm";

const {
  useChannelChatMock,
  useConversationDetailMock,
  useConversationThreadsMock,
} = vi.hoisted(() => ({
  useChannelChatMock: vi.fn(),
  useConversationDetailMock: vi.fn(),
  useConversationThreadsMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../hooks/useChannelChat", () => ({
  useChannelChat: useChannelChatMock,
}));
vi.mock("../hooks/useConversationDetail", () => ({
  useConversationDetail: useConversationDetailMock,
}));
vi.mock("../hooks/useConversationThreads", () => ({
  useConversationThreads: useConversationThreadsMock,
}));
vi.mock("../hooks/useBotRuntime", () => ({
  useBotRuntime: () => ({ data: null, isLoading: false }),
  useBotRuntimeCache: () => ({
    mergeInvocationUpdate: vi.fn(),
    mergeProgressEvent: vi.fn(),
    invalidate: vi.fn(),
  }),
}));
vi.mock("../components/HermesDmChatView", () => ({
  HermesDmChatView: () => <div data-testid="hermes-chat" />,
}));
vi.mock("../components/ChannelChatView", () => ({
  ChannelChatView: () => <div data-testid="channel-chat" />,
}));
vi.mock("../components/HermesRuntimePanel", () => ({
  HermesRuntimePanel: ({
    activeThreadId,
    onSelectThread,
  }: {
    activeThreadId: string | null;
    onSelectThread?: (threadId: string | null) => void;
  }) => (
    <div>
      <output data-testid="active-thread">{activeThreadId ?? "general"}</output>
      <button type="button" onClick={() => onSelectThread?.(null)}>
        General
      </button>
      <button type="button" onClick={() => onSelectThread?.("task-a")}>
        Task A
      </button>
      <button type="button" onClick={() => onSelectThread?.("task-b")}>
        Task B
      </button>
    </div>
  ),
}));

const user = {
  id: "user-1",
  name: "Test User",
  email: "test@example.com",
  avatar: null,
  type: "human" as const,
};

function conversation(id: string, botUserId: string, botId: string) {
  return {
    id,
    type: "direct" as const,
    workspaceId: "workspace-1",
    participants: [
      { userId: user.id, user },
      {
        userId: botUserId,
        user: {
          id: botUserId,
          name: id === "dm-1" ? "Koda" : "Hermes Two",
          email: null,
          avatar: null,
          type: "bot" as const,
        },
        bot: { id: botId, kind: "hermes" as const },
      },
    ],
  };
}

const detailsById: Record<string, ReturnType<typeof conversation>> = {
  "dm-1": conversation("dm-1", "bot-user-1", "bot-1"),
  "dm-2": conversation("dm-2", "bot-user-2", "bot-2"),
};

const threadResult = {
  threads: [
    { id: "task-a", title: "Task A" },
    { id: "task-b", title: "Task B" },
  ],
  loading: false,
  loadingMore: false,
  hasMore: false,
  createThread: vi.fn(),
  renameThread: vi.fn(),
  touchThread: vi.fn(),
  loadMore: vi.fn(),
};

function KeybindingsHarness() {
  useKeybindings({
    handleRegistryCommands: true,
    onPermissionAllow: null,
    onPermissionDeny: null,
    onPermissionDenyWithFeedback: null,
  });
  return null;
}

async function renderDmRoute(initialId = "dm-1") {
  const rootRoute = createRootRoute();
  const dmRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/dm/$id",
    component: () => (
      <>
        <KeybindingsHarness />
        <DmRoute />
      </>
    ),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([dmRoute]),
    history: createMemoryHistory({ initialEntries: [`/dm/${initialId}`] }),
  });
  await act(async () => {
    render(<RouterProvider router={router as never} />);
  });
  return router;
}

function attentionCommand() {
  const command = useCommandsStore
    .getState()
    .commands.find((candidate) => candidate.id === "needs-attention");
  if (!command) throw new Error("Needs attention command was not registered");
  return command;
}

describe("DmRoute needs attention scope lifecycle", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const values: Record<string, string> = {};
    vi.mocked(invoke).mockImplementation(async (commandName, args) => {
      const input = args as
        | {
            key?: string;
            expectedValue?: string | null;
            value?: string | null;
          }
        | undefined;
      const key = input?.key ?? "";
      if (commandName === "kv_get") return values[key] ?? null;
      if (commandName === "kv_compare_and_set") {
        if ((values[key] ?? null) !== (input?.expectedValue ?? null)) return false;
        if (input?.value == null) delete values[key];
        else values[key] = input.value;
        return true;
      }
      throw new Error(`Unexpected command: ${commandName}`);
    });

    useAuthStore.setState({ user, token: "token", loading: false });
    useWorkspacesStore.setState({
      workspaces: [],
      activeWorkspace: {
        id: "workspace-1",
        name: "Workspace",
        createdAt: "2026-08-11T00:00:00Z",
        updatedAt: "2026-08-11T00:00:00Z",
        members: [],
        channels: [],
      },
      loading: false,
    });
    useWebSocketStore.setState({ sendMessage: vi.fn() });
    useHermesIndicatorsStore.getState().resetForTests();
    useHermesApprovalsStore.getState().resetForTests();
    useNeedsAttentionStore.getState().resetForTests();
    useCommandsStore.setState({ commands: [] });

    useConversationDetailMock.mockImplementation((id: string) => ({
      data: detailsById[id] ?? null,
      isLoading: false,
      error: null,
    }));
    useConversationThreadsMock.mockReturnValue(threadResult);
    useChannelChatMock.mockReturnValue({
      messages: [],
      loading: false,
      loadingMore: false,
      hasMore: false,
      error: null,
      queuedMessages: [],
      sendMessage: vi.fn(),
      loadMore: vi.fn(),
      addMessage: vi.fn(),
      updateMessage: vi.fn(),
      removeMessage: vi.fn(),
      setMessages: vi.fn(),
      setError: vi.fn(),
      setQueuedMessages: vi.fn(),
    });

    await useNeedsAttentionStore.getState().initialize(user.id);
  });

  it("marks only the selected task or General while navigating Hermes DMs", async () => {
    const router = await renderDmRoute();

    fireEvent.click(screen.getByRole("button", { name: "Task A" }));
    await waitFor(() => expect(screen.getByTestId("active-thread")).toHaveTextContent("task-a"));
    await act(async () => attentionCommand().execute());
    expect(scopeNeedsAttention(useNeedsAttentionStore.getState().scopes, "dm-1", "task-a")).toBe(true);
    expect(scopeNeedsAttention(useNeedsAttentionStore.getState().scopes, "dm-1", "task-b")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Task B" }));
    await waitFor(() => expect(screen.getByTestId("active-thread")).toHaveTextContent("task-b"));
    fireEvent.keyDown(window, { key: "x", ctrlKey: true });
    fireEvent.keyDown(window, { key: "m" });
    await waitFor(() =>
      expect(scopeNeedsAttention(useNeedsAttentionStore.getState().scopes, "dm-1", "task-b")).toBe(true),
    );
    expect(scopeNeedsAttention(useNeedsAttentionStore.getState().scopes, "dm-1", "task-a")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "General" }));
    await waitFor(() => expect(screen.getByTestId("active-thread")).toHaveTextContent("general"));
    await act(async () => attentionCommand().execute());
    expect(scopeNeedsAttention(useNeedsAttentionStore.getState().scopes, "dm-1")).toBe(true);
    expect(scopeNeedsAttention(useNeedsAttentionStore.getState().scopes, "dm-1", "task-b")).toBe(true);

    await act(async () => {
      await router.navigate({ to: "/dm/$id", params: { id: "dm-2" } });
    });
    await waitFor(() => expect(screen.getByTestId("active-thread")).toHaveTextContent("general"));
    await act(async () => attentionCommand().execute());

    expect(scopeNeedsAttention(useNeedsAttentionStore.getState().scopes, "dm-2")).toBe(true);
    expect(scopeNeedsAttention(useNeedsAttentionStore.getState().scopes, "dm-2", "task-a")).toBe(false);
    expect(scopeNeedsAttention(useNeedsAttentionStore.getState().scopes, "dm-1", "task-a")).toBe(true);
  });
});
