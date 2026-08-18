import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { StrictMode } from "react";
import {
  RouterProvider,
  createMemoryHistory,
  createRouter,
  createRootRoute,
  createRoute,
} from "@tanstack/react-router";
import { useTodoStore, setTodos } from "../core/todo";
import { usePermissionStore } from "../core/permission";
import { useQuestionStore } from "../core/question";
import {
  composerDraftKey,
  useComposerDraftsStore,
} from "../stores/composer-drafts";

// -- Mocks --

const lifecycleMocks = vi.hoisted(() => ({
  activateAgentChatMcp: vi.fn(),
  deactivateAgentChatMcp: vi.fn(),
  syncAgentChatMcpAuth: vi.fn(),
}));

vi.mock("../desktop-lifecycle", () => ({
  activateAgentChatMcp: (...args: unknown[]) => {
    lifecycleMocks.activateAgentChatMcp(...args);
    return lifecycleMocks.deactivateAgentChatMcp;
  },
  syncAgentChatMcpAuth: lifecycleMocks.syncAgentChatMcpAuth,
}));

// Mock Tauri invoke — used by the route for list_conversations, get_initial_project_dir, etc.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve(null)),
}));

// Mock useChat — the route's heaviest dependency
vi.mock("../hooks/useChat", () => ({
  useChat: vi.fn(() => ({
    messages: [],
    conversation: null,
    error: null,
    queuedMessages: [],
    sendMessage: vi.fn(),
    stopStreaming: vi.fn(),
    loadConversation: vi.fn(),
    startNewConversation: vi.fn(),
  })),
}));

// Mock child components that have their own complex deps
vi.mock("../components/ProjectPicker", () => ({
  ProjectPicker: () => <div data-testid="project-picker" />,
}));

vi.mock("../components/InputBar", () => ({
  InputBar: ({ draftKey }: { draftKey: string }) => (
    <div data-testid="input-bar" data-draft-key={draftKey} />
  ),
}));

vi.mock("../ChatMessage", () => ({
  ChatMessage: ({ message }: any) => <div data-testid={`msg-${message.id}`} />,
  StreamingMessage: () => <div data-testid="streaming-message" />,
}));

vi.mock("../components/ChatHeader", () => ({
  setAgentChatTitle: vi.fn(),
  setAgentChatProjectDir: vi.fn(),
}));

vi.mock("../hooks/useKeybindings", () => ({
  useKeybindings: vi.fn(),
}));

vi.mock("../lib/notifications", () => ({
  fireNotification: vi.fn(),
}));

// jsdom doesn't implement scrollIntoView or scrollTo
Element.prototype.scrollIntoView = vi.fn();
Element.prototype.scrollTo = vi.fn() as any;

import { useChat } from "../hooks/useChat";
import { AgentChatRoute } from "./agent-chat";

const mockUseChat = vi.mocked(useChat);

// Helper to render the route inside a TanStack Router
async function renderRoute(path = "/chat", strict = false) {
  const rootRoute = createRootRoute();
  const chatRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/chat",
    component: AgentChatRoute,
    validateSearch: (search: Record<string, unknown>) => ({
      projectDir: (search.projectDir as string) || undefined,
    }),
  });
  const chatIdRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/chat/$id",
    component: AgentChatRoute,
  });
  const routeTree = rootRoute.addChildren([chatRoute, chatIdRoute]);
  const memoryHistory = createMemoryHistory({ initialEntries: [path] });
  const router = createRouter({ routeTree, history: memoryHistory });

  let result!: ReturnType<typeof render>;
  await act(async () => {
    const route = <RouterProvider router={router as any} />;
    result = render(strict ? <StrictMode>{route}</StrictMode> : route);
  });
  return result;
}

beforeEach(() => {
  vi.clearAllMocks();
  useTodoStore.setState({ todos: {} });
  usePermissionStore.setState({ pending: {} });
  useQuestionStore.setState({ pending: {} });
  useComposerDraftsStore.setState({
    drafts: {},
    revisions: {},
    imageDrafts: {},
    attachmentDrafts: {},
    sendingAttachments: {},
  });

  // Default useChat mock — no conversation
  mockUseChat.mockReturnValue({
    messages: [],
    conversation: null,
    error: null,
    queuedMessages: [],
    sendMessage: vi.fn(),
    stopStreaming: vi.fn(),
    loadConversation: vi.fn(),
    startNewConversation: vi.fn(),
  } as any);
});

describe("AgentChatRoute", () => {
  it("renders without crashing (no conversation)", async () => {
    await renderRoute();
    expect(screen.getByText("Send a message to start chatting")).toBeInTheDocument();
    expect(lifecycleMocks.activateAgentChatMcp).toHaveBeenCalledOnce();
    expect(lifecycleMocks.activateAgentChatMcp).toHaveBeenCalledWith(null);
  });

  it("releases and reacquires the lifecycle lease under StrictMode", async () => {
    const result = await renderRoute("/chat", true);

    expect(lifecycleMocks.activateAgentChatMcp).toHaveBeenCalledTimes(2);
    expect(lifecycleMocks.deactivateAgentChatMcp).toHaveBeenCalledOnce();

    result.unmount();
    expect(lifecycleMocks.deactivateAgentChatMcp).toHaveBeenCalledTimes(2);
  });

  it("releases the lifecycle lease on route unmount and reacquires it on remount", async () => {
    const first = await renderRoute();
    first.unmount();

    expect(lifecycleMocks.deactivateAgentChatMcp).toHaveBeenCalledOnce();

    await renderRoute();
    expect(lifecycleMocks.activateAgentChatMcp).toHaveBeenCalledTimes(2);
  });

  it("does not show TodoPanel when there are no todos", async () => {
    await renderRoute();
    expect(screen.queryByText("Tasks")).not.toBeInTheDocument();
  });

  it("shows TodoPanel when conversation has todos", async () => {
    const convId = "conv-123";
    mockUseChat.mockReturnValue({
      messages: [],
      conversation: { id: convId, title: "Test", project_dir: null, created_at: "", updated_at: "" },
      error: null,
      queuedMessages: [],
      sendMessage: vi.fn(),
      stopStreaming: vi.fn(),
      loadConversation: vi.fn(),
      startNewConversation: vi.fn(),
    } as any);

    setTodos([{ id: "1", content: "Do stuff", status: "pending" }], convId);

    await renderRoute();
    expect(screen.getByText("Tasks")).toBeInTheDocument();
    expect(screen.getByText("Do stuff")).toBeInTheDocument();
  });

  it("does not show todos from a different conversation", async () => {
    const convId = "conv-123";
    mockUseChat.mockReturnValue({
      messages: [],
      conversation: { id: convId, title: "Test", project_dir: null, created_at: "", updated_at: "" },
      error: null,
      queuedMessages: [],
      sendMessage: vi.fn(),
      stopStreaming: vi.fn(),
      loadConversation: vi.fn(),
      startNewConversation: vi.fn(),
    } as any);

    // Todos exist for a different conversation
    setTodos([{ id: "1", content: "Other conv task", status: "pending" }], "conv-other");

    await renderRoute();
    expect(screen.queryByText("Tasks")).not.toBeInTheDocument();
    expect(screen.queryByText("Other conv task")).not.toBeInTheDocument();
  });

  it("reacts to todo store updates for current conversation", async () => {
    const convId = "conv-123";
    mockUseChat.mockReturnValue({
      messages: [],
      conversation: { id: convId, title: "Test", project_dir: null, created_at: "", updated_at: "" },
      error: null,
      queuedMessages: [],
      sendMessage: vi.fn(),
      stopStreaming: vi.fn(),
      loadConversation: vi.fn(),
      startNewConversation: vi.fn(),
    } as any);

    await renderRoute();
    expect(screen.queryByText("Tasks")).not.toBeInTheDocument();

    // Simulate a tool writing todos mid-stream
    act(() => {
      setTodos([{ id: "1", content: "New task from tool", status: "in_progress" }], convId);
    });

    expect(screen.getByText("Tasks")).toBeInTheDocument();
    expect(screen.getByText("New task from tool")).toBeInTheDocument();
  });

  it("renders queued messages with Queued badge", async () => {
    const convId = "conv-123";
    mockUseChat.mockReturnValue({
      messages: [],
      conversation: { id: convId, title: "Test", project_dir: null, created_at: "", updated_at: "" },
      error: null,
      queuedMessages: [
        { id: "qm-1", content: "my queued question" },
      ],
      sendMessage: vi.fn(),
      stopStreaming: vi.fn(),
      loadConversation: vi.fn(),
      startNewConversation: vi.fn(),
    } as any);

    await renderRoute();
    expect(screen.getByText("my queued question")).toBeInTheDocument();
    expect(screen.getByText("Queued")).toBeInTheDocument();
    expect(screen.getByText("You")).toBeInTheDocument();
  });

  it("renders multiple queued messages in order", async () => {
    const convId = "conv-456";
    mockUseChat.mockReturnValue({
      messages: [],
      conversation: { id: convId, title: "Test", project_dir: null, created_at: "", updated_at: "" },
      error: null,
      queuedMessages: [
        { id: "qm-1", content: "first queued" },
        { id: "qm-2", content: "second queued" },
      ],
      sendMessage: vi.fn(),
      stopStreaming: vi.fn(),
      loadConversation: vi.fn(),
      startNewConversation: vi.fn(),
    } as any);

    await renderRoute();
    expect(screen.getByText("first queued")).toBeInTheDocument();
    expect(screen.getByText("second queued")).toBeInTheDocument();
    // Both should have Queued badges
    const badges = screen.getAllByText("Queued");
    expect(badges).toHaveLength(2);
  });

  it("does not render queued messages section when queue is empty", async () => {
    const convId = "conv-789";
    mockUseChat.mockReturnValue({
      messages: [],
      conversation: { id: convId, title: "Test", project_dir: null, created_at: "", updated_at: "" },
      error: null,
      queuedMessages: [],
      sendMessage: vi.fn(),
      stopStreaming: vi.fn(),
      loadConversation: vi.fn(),
      startNewConversation: vi.fn(),
    } as any);

    await renderRoute();
    expect(screen.queryByText("Queued")).not.toBeInTheDocument();
  });

  it("no infinite loop when convId is undefined (new chat)", async () => {
    // This was the original bug: useTodoStore selector returning a new [] each render
    mockUseChat.mockReturnValue({
      messages: [],
      conversation: null, // no conversation yet → convId is undefined
      error: null,
      queuedMessages: [],
      sendMessage: vi.fn(),
      stopStreaming: vi.fn(),
      loadConversation: vi.fn(),
      startNewConversation: vi.fn(),
    } as any);

    // Should render without infinite loop / error
    await renderRoute();
    expect(screen.getByText("Send a message to start chatting")).toBeInTheDocument();
  });

  it("uses the route id for the draft while stale conversation details are loading", async () => {
    mockUseChat.mockReturnValue({
      messages: [],
      conversation: {
        id: "conversation-a",
        title: "Previous conversation",
        project_dir: null,
        created_at: "",
        updated_at: "",
      },
      error: null,
      queuedMessages: [],
      sendMessage: vi.fn(),
      stopStreaming: vi.fn(),
      loadConversation: vi.fn(),
      startNewConversation: vi.fn(),
    } as any);

    await renderRoute("/chat/conversation-b");

    expect(screen.getByTestId("input-bar")).toHaveAttribute(
      "data-draft-key",
      composerDraftKey.agent("conversation-b"),
    );
  });

  it("moves the provisional draft before promoting a new conversation route", async () => {
    const provisionalKey = composerDraftKey.agent(undefined);
    const durableKey = composerDraftKey.agent("conversation-created");
    useComposerDraftsStore
      .getState()
      .setDraft(provisionalKey, "typed while the conversation was created");
    mockUseChat.mockReturnValue({
      messages: [],
      conversation: {
        id: "conversation-created",
        title: "Created conversation",
        project_dir: null,
        created_at: "",
        updated_at: "",
      },
      error: null,
      queuedMessages: [],
      sendMessage: vi.fn(),
      stopStreaming: vi.fn(),
      loadConversation: vi.fn(),
      startNewConversation: vi.fn(),
    } as any);

    await renderRoute();

    expect(screen.getByTestId("input-bar")).toHaveAttribute(
      "data-draft-key",
      durableKey,
    );
    expect(useComposerDraftsStore.getState().drafts).toEqual({
      [durableKey]: "typed while the conversation was created",
    });
  });
});
