import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, act, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
import { useHermesIndicatorsStore } from "../stores/hermes-indicators";
import {
  needsAttentionScopeKey,
  useNeedsAttentionStore,
} from "../stores/needs-attention";
import { registerGlobalWsHandlers } from "../lib/ws-global-handlers";
import { wsEvents } from "../lib/ws-events";
import type { Conversation } from "../core/types";
import type {
  AuthUser,
  WorkspaceListItem,
  WorkspaceWithDetails,
} from "@thechat/shared";

import { Sidebar, useSidebarState } from "./Sidebar";

const {
  dmPostMock,
  openCreateChannelModalMock,
  openRenameChannelModalMock,
  openDeleteChannelModalMock,
} = vi.hoisted(() => ({
  dmPostMock: vi.fn(),
  openCreateChannelModalMock: vi.fn(),
  openRenameChannelModalMock: vi.fn(),
  openDeleteChannelModalMock: vi.fn(),
}));

vi.mock("../lib/api", () => ({
  api: {
    conversations: {
      dm: { post: dmPostMock },
    },
  },
}));

vi.mock("../lib/notifications", () => ({
  fireNotification: vi.fn(),
}));

vi.mock("./ChannelModal", () => ({
  openCreateChannelModal: openCreateChannelModalMock,
  openRenameChannelModal: openRenameChannelModalMock,
  openDeleteChannelModal: openDeleteChannelModalMock,
}));

const conversations: Conversation[] = [
  { id: "c1", title: "Chat 1", project_dir: null, created_at: "2026-01-01", updated_at: "2026-01-01" },
  { id: "c2", title: "Chat 2", project_dir: null, created_at: "2026-01-02", updated_at: "2026-01-02" },
];

const user: AuthUser = {
  id: "u1",
  name: "Test User",
  email: "test@example.com",
  avatar: null,
  type: "human",
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
      user: { id: "u1", name: "Test User", email: "test@example.com", avatar: null, type: "human" as const },
    },
    {
      userId: "u2",
      role: "member",
      joinedAt: "2026-01-02",
      user: { id: "u2", name: "Alice", email: "alice@example.com", avatar: null, type: "human" as const },
    },
    {
      userId: "u-bot",
      role: "member",
      joinedAt: "2026-01-03",
      user: { id: "u-bot", name: "Koda", email: null, avatar: null, type: "bot" as const },
      bot: { id: "bot-1", kind: "hermes" as const },
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

async function renderSidebarAt(initialEntry: string) {
  const rootRoute = createRootRoute({
    component: Sidebar,
  });
  const channelRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/channel/$id",
    component: () => null,
  });
  const dmRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/dm/$id",
    component: () => null,
  });
  const routeTree = rootRoute.addChildren([channelRoute, dmRoute]);
  const memoryHistory = createMemoryHistory({ initialEntries: [initialEntry] });
  const router = createRouter({ routeTree, history: memoryHistory });

  let result!: ReturnType<typeof render>;
  await act(async () => {
    result = render(<RouterProvider router={router as any} />);
  });
  return { result, router };
}

beforeEach(() => {
  // Reset stores to default state
  useSidebarState.setState({ open: true, tab: "agent" });
  useAuthStore.setState({ user: null, token: null, loading: false });
  useWorkspacesStore.setState({ workspaces: [], activeWorkspace: null, loading: false });
  useHermesIndicatorsStore.getState().resetForTests();
  useNeedsAttentionStore.getState().resetForTests();
  useConversationsStore.setState({
    conversations: [],
    unreadAgentChats: new Set(),
    unreadChannels: new Set(),
    directConversationIdsByUserId: {},
    unreadBotConversations: {},
    activeDirectConversationId: null,
  });
  vi.clearAllMocks();
});

describe("Sidebar", () => {
  it("renders correctly when not logged in", async () => {
    useConversationsStore.setState({ conversations });

    await renderWithRouter(<Sidebar />);

    expect(screen.getByText("Log in")).toBeInTheDocument();
    expect(screen.queryByText("New Chat")).not.toBeInTheDocument();
    expect(screen.queryByText("Chat 1")).not.toBeInTheDocument();
    expect(screen.queryByText("Chat 2")).not.toBeInTheDocument();
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
    expect(screen.getByLabelText("Notifications")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Test User"));
    expect(screen.getByText("Manage bots")).toBeInTheDocument();
    expect(screen.getByText("Settings")).toBeInTheDocument();
    expect(screen.getByText("Log out")).toBeInTheDocument();
    expect(screen.queryByText("ChatGPT")).not.toBeInTheDocument();
  });

  it("renders channels and members when workspace is active", async () => {
    useAuthStore.setState({ user, token: "test-token" });
    useWorkspacesStore.setState({ workspaces: workspaceList, activeWorkspace });
    useConversationsStore.setState({ conversations });

    await renderWithRouter(<Sidebar />);

    // Workspace name shown in switcher
    expect(screen.getByText("Team Alpha")).toBeInTheDocument();
    expect(screen.queryByText("Agent Chats")).not.toBeInTheDocument();
    expect(screen.queryByText("New Chat")).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Search")).not.toBeInTheDocument();

    // Channels and DMs shown
    expect(screen.getByText("Channels")).toBeInTheDocument();
    expect(screen.getByText(/general/)).toBeInTheDocument();
    expect(screen.getByText("People")).toBeInTheDocument();
    expect(screen.getByText("Alice")).toBeInTheDocument();

    // Notifications button remains available at the top.
    expect(screen.getByLabelText("Notifications")).toBeInTheDocument();
  });

  it("shows local attention markers for channels and DMs containing marked tasks", async () => {
    useAuthStore.setState({ user, token: "test-token" });
    useWorkspacesStore.setState({ workspaces: workspaceList, activeWorkspace });
    useConversationsStore.setState({
      directConversationIdsByUserId: { "u-bot": "dm-bot" },
    });
    useNeedsAttentionStore.setState({
      activeUserId: user.id,
      initialized: true,
      scopes: {
        [needsAttentionScopeKey("ch1")]: {
          conversationId: "ch1",
          threadId: null,
        },
        [needsAttentionScopeKey("dm-bot", "task-1")]: {
          conversationId: "dm-bot",
          threadId: "task-1",
        },
      },
    });

    await renderWithRouter(<Sidebar />);

    expect(
      screen.getByRole("button", { name: "#general, needs attention" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Koda, needs attention" }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("needs-attention-ch1")).toHaveTextContent("!");
    expect(screen.getByTestId("needs-attention-dm-bot")).toHaveTextContent("!");
  });

  it("opens create, rename, and delete channel controls for workspace owners", async () => {
    const ui = userEvent.setup();
    useAuthStore.setState({ user, token: "test-token" });
    useWorkspacesStore.setState({ workspaces: workspaceList, activeWorkspace });

    await renderWithRouter(<Sidebar />);

    await ui.click(screen.getByRole("button", { name: "Create channel" }));
    expect(openCreateChannelModalMock).toHaveBeenCalledOnce();

    await ui.click(screen.getByRole("button", { name: "Manage #general" }));
    await ui.click(screen.getByRole("menuitem", { name: "Rename channel" }));
    expect(openRenameChannelModalMock).toHaveBeenCalledWith(
      activeWorkspace.channels[0],
    );

    await ui.click(screen.getByRole("button", { name: "Manage #general" }));
    await ui.click(screen.getByRole("menuitem", { name: "Delete channel" }));
    expect(openDeleteChannelModalMock).toHaveBeenCalledWith(
      activeWorkspace.channels[0],
    );
  });

  it("gives workspace admins channel manager controls", async () => {
    const adminWorkspace: WorkspaceWithDetails = {
      ...activeWorkspace,
      members: activeWorkspace.members.map((member) =>
        member.userId === user.id ? { ...member, role: "admin" } : member,
      ),
    };
    useAuthStore.setState({ user, token: "test-token" });
    useWorkspacesStore.setState({
      workspaces: [{ ...workspaceList[0], role: "admin" }],
      activeWorkspace: adminWorkspace,
    });

    await renderWithRouter(<Sidebar />);

    expect(
      screen.getByRole("button", { name: "Manage #general" }),
    ).toBeInTheDocument();
  });

  it("supports keyboard navigation and restores focus in channel menus", async () => {
    const ui = userEvent.setup();
    useAuthStore.setState({ user, token: "test-token" });
    useWorkspacesStore.setState({ workspaces: workspaceList, activeWorkspace });
    await renderWithRouter(<Sidebar />);

    const trigger = screen.getByRole("button", { name: "Manage #general" });
    trigger.focus();
    await ui.keyboard("{Enter}");
    const renameItem = await screen.findByRole("menuitem", {
      name: "Rename channel",
    });
    const deleteItem = screen.getByRole("menuitem", { name: "Delete channel" });
    expect(renameItem).toHaveFocus();

    await ui.keyboard("{ArrowDown}");
    expect(deleteItem).toHaveFocus();
    await ui.keyboard("{Escape}");
    expect(trigger).toHaveFocus();
  });

  it("allows members to create channels without exposing manager actions", async () => {
    const memberWorkspace: WorkspaceWithDetails = {
      ...activeWorkspace,
      members: activeWorkspace.members.map((member) =>
        member.userId === user.id ? { ...member, role: "member" } : member,
      ),
    };
    useAuthStore.setState({ user, token: "test-token" });
    useWorkspacesStore.setState({
      workspaces: [{ ...workspaceList[0], role: "member" }],
      activeWorkspace: memberWorkspace,
    });

    await renderWithRouter(<Sidebar />);

    expect(screen.getByRole("button", { name: "Create channel" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Manage #general" })).not.toBeInTheDocument();
  });

  it("does not show agent chats in the sidebar UI", async () => {
    useConversationsStore.setState({ conversations });

    // Not logged in
    const { unmount } = await renderWithRouter(<Sidebar />);
    expect(screen.queryByText("New Chat")).not.toBeInTheDocument();
    expect(screen.queryByText("Chat 1")).not.toBeInTheDocument();
    unmount();

    // Logged in, no workspace
    useAuthStore.setState({ user, token: "test-token" });
    useWorkspacesStore.setState({ workspaces: workspaceList });
    const { unmount: unmount2 } = await renderWithRouter(<Sidebar />);
    expect(screen.queryByText("New Chat")).not.toBeInTheDocument();
    expect(screen.queryByText("Chat 1")).not.toBeInTheDocument();
    unmount2();

    // Logged in, with workspace
    useWorkspacesStore.setState({ activeWorkspace });
    await renderWithRouter(<Sidebar />);
    expect(screen.queryByText("Agent Chats")).not.toBeInTheDocument();
    expect(screen.queryByText("Chat 1")).not.toBeInTheDocument();
  });

  it("shows and clears a bot unread indicator across real message and route state", async () => {
    useAuthStore.setState({ user, token: "test-token" });
    useWorkspacesStore.setState({ workspaces: workspaceList, activeWorkspace });
    dmPostMock.mockResolvedValue({ data: { id: "dm-bot" }, error: null });
    const { router } = await renderSidebarAt("/channel/ch1");
    const cleanup = registerGlobalWsHandlers(() => {});

    const emitBotMessage = (id: string) => {
      wsEvents.emit("ws:new_message", {
        conversationType: "direct",
        message: {
          id,
          conversationId: "dm-bot",
          threadId: null,
          senderId: "u-bot",
          senderName: "Koda",
          senderType: "bot",
          content: "Background response",
          parts: null,
          createdAt: "2026-07-27T08:00:00.000Z",
        },
      });
    };

    act(() => emitBotMessage("msg-1"));
    expect(screen.getByRole("button", { name: "Koda, unread" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Koda, unread" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/dm/dm-bot"));
    expect(screen.getByRole("button", { name: "Koda" })).toBeInTheDocument();

    act(() => emitBotMessage("msg-2"));
    expect(screen.queryByRole("button", { name: "Koda, unread" })).not.toBeInTheDocument();

    await act(async () => {
      await router.navigate({ to: "/channel/$id", params: { id: "ch1" } });
    });
    act(() => {
      emitBotMessage("msg-3");
      emitBotMessage("msg-4");
    });
    expect(screen.getAllByRole("button", { name: "Koda, unread" })).toHaveLength(1);

    cleanup();
  });
});
