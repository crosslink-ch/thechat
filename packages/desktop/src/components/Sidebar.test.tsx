import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import {
  RouterProvider,
  createMemoryHistory,
  createRouter,
  createRootRoute,
  createRoute,
} from "@tanstack/react-router";
import { useAuthStore } from "../stores/auth";
import { useWorkspacesStore } from "../stores/workspaces";
import { useConversationsStore } from "../stores/conversations";
import type { Conversation } from "../core/types";
import type {
  AuthUser,
  WorkspaceListItem,
  WorkspaceWithDetails,
} from "@thechat/shared";

import { Sidebar, useSidebarState } from "./Sidebar";

const conversations: Conversation[] = [
  { id: "c1", title: "Chat 1", project_dir: null, created_at: "2026-01-01", updated_at: "2026-01-01" },
  { id: "c2", title: "Chat 2", project_dir: null, created_at: "2026-01-02", updated_at: "2026-01-02" },
];

const user: AuthUser = {
  id: "u1",
  name: "Test User",
  email: "test@example.com",
  avatar: null,
};

const workspaceList: WorkspaceListItem[] = [
  { id: "ws-1", name: "Team Alpha", role: "owner", createdAt: "2026-01-01", updatedAt: "2026-01-01" },
  { id: "ws-2", name: "Team Beta", role: "member", createdAt: "2026-01-02", updatedAt: "2026-01-02" },
];

const activeWorkspace: WorkspaceWithDetails = {
  id: "ws-1",
  name: "Team Alpha",
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
  members: [
    {
      userId: "u1",
      role: "owner",
      joinedAt: "2026-01-01",
      user: { id: "u1", name: "Test User", email: "test@example.com", avatar: null },
    },
    {
      userId: "u2",
      role: "member",
      joinedAt: "2026-01-02",
      user: { id: "u2", name: "Alice", email: "alice@example.com", avatar: null },
    },
  ],
  channels: [
    {
      id: "ch1",
      workspaceId: "ws-1",
      name: "general",
      title: "General",
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
    },
  ],
};

async function renderWithRouter(component: React.ReactNode) {
  const rootRoute = createRootRoute({
    component: () => component,
  });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => null,
  });
  const routeTree = rootRoute.addChildren([indexRoute]);
  const memoryHistory = createMemoryHistory({ initialEntries: ["/"] });
  const router = createRouter({ routeTree, history: memoryHistory });

  let result!: ReturnType<typeof render>;
  await act(async () => {
    result = render(<RouterProvider router={router as any} />);
  });
  return result;
}

beforeEach(() => {
  // Reset stores to default state
  useSidebarState.setState({ open: false, tab: "workspace" });
  useAuthStore.setState({ user: null, token: null, loading: false });
  useWorkspacesStore.setState({ workspaces: [], activeWorkspace: null, loading: false });
  useConversationsStore.setState({
    conversations: [],
    unreadAgentChats: new Set(),
    unreadChannels: new Set(),
  });
});

describe("Sidebar", () => {
  it("renders correctly when not logged in", async () => {
    useConversationsStore.setState({ conversations });

    await renderWithRouter(<Sidebar />);

    expect(screen.getByText("Log in")).toBeInTheDocument();
    expect(screen.getByText("+ New Chat")).toBeInTheDocument();
    expect(screen.getByText("Chat 1")).toBeInTheDocument();
    expect(screen.getByText("Chat 2")).toBeInTheDocument();
    // No workspace switcher
    expect(screen.queryByText("Select workspace")).not.toBeInTheDocument();
  });

  it("renders workspace switcher when logged in", async () => {
    useAuthStore.setState({ user, token: "test-token" });
    useWorkspacesStore.setState({ workspaces: workspaceList });
    useConversationsStore.setState({ conversations });

    await renderWithRouter(<Sidebar />);

    expect(screen.getByText("Select workspace")).toBeInTheDocument();
    expect(screen.getByText("Test User")).toBeInTheDocument();
    expect(screen.getByText("Log out")).toBeInTheDocument();
  });

  it("renders channels and members when workspace is active", async () => {
    useAuthStore.setState({ user, token: "test-token" });
    useWorkspacesStore.setState({ workspaces: workspaceList, activeWorkspace });
    useConversationsStore.setState({ conversations });

    await renderWithRouter(<Sidebar />);

    // Workspace name shown in switcher
    expect(screen.getByText("Team Alpha")).toBeInTheDocument();
    // Tab bar with Workspace and Agent Chats tabs
    expect(screen.getByText("Workspace")).toBeInTheDocument();
    expect(screen.getByText("Agent Chats")).toBeInTheDocument();
    // Workspace tab active by default: channels and DMs shown
    expect(screen.getByText("Channels")).toBeInTheDocument();
    expect(screen.getByText(/general/)).toBeInTheDocument();
    expect(screen.getByText("Direct Messages")).toBeInTheDocument();
    expect(screen.getByText("Alice")).toBeInTheDocument();
  });

  it("shows agent chats in all modes", async () => {
    useConversationsStore.setState({ conversations });

    // Not logged in — agent chats shown directly (no tabs)
    const { unmount } = await renderWithRouter(<Sidebar />);
    expect(screen.getByText("+ New Chat")).toBeInTheDocument();
    expect(screen.getByText("Chat 1")).toBeInTheDocument();
    unmount();

    // Logged in, no workspace — agent chats shown directly (no tabs)
    useAuthStore.setState({ user, token: "test-token" });
    useWorkspacesStore.setState({ workspaces: workspaceList });
    const { unmount: unmount2 } = await renderWithRouter(<Sidebar />);
    expect(screen.getByText("+ New Chat")).toBeInTheDocument();
    expect(screen.getByText("Chat 1")).toBeInTheDocument();
    unmount2();

    // Logged in, with workspace — Agent Chats tab visible
    useWorkspacesStore.setState({ activeWorkspace });
    await renderWithRouter(<Sidebar />);
    expect(screen.getByText("Agent Chats")).toBeInTheDocument();
  });
});
