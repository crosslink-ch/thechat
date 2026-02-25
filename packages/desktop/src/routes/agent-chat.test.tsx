import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
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

// -- Mocks --

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
  InputBar: () => <div data-testid="input-bar" />,
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

// jsdom doesn't implement scrollIntoView
Element.prototype.scrollIntoView = vi.fn();

import { useChat } from "../hooks/useChat";
import { AgentChatRoute } from "./agent-chat";

const mockUseChat = vi.mocked(useChat);

// Helper to render the route inside a TanStack Router
async function renderRoute(path = "/chat") {
  const rootRoute = createRootRoute();
  const chatRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/chat",
    component: AgentChatRoute,
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
    result = render(<RouterProvider router={router as any} />);
  });
  return result;
}

beforeEach(() => {
  vi.clearAllMocks();
  useTodoStore.setState({ todos: {} });
  usePermissionStore.setState({ pending: {} });
  useQuestionStore.setState({ pending: {} });

  // Default useChat mock — no conversation
  mockUseChat.mockReturnValue({
    messages: [],
    conversation: null,
    error: null,
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

  it("no infinite loop when convId is undefined (new chat)", async () => {
    // This was the original bug: useTodoStore selector returning a new [] each render
    mockUseChat.mockReturnValue({
      messages: [],
      conversation: null, // no conversation yet → convId is undefined
      error: null,
      sendMessage: vi.fn(),
      stopStreaming: vi.fn(),
      loadConversation: vi.fn(),
      startNewConversation: vi.fn(),
    } as any);

    // Should render without infinite loop / error
    await renderRoute();
    expect(screen.getByText("Send a message to start chatting")).toBeInTheDocument();
  });
});
