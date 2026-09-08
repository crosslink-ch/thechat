import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ActivitySnapshot, WorkspaceInvite } from "@thechat/shared";
import { useActivityStore } from "../stores/activity";
import { useNotificationsStore } from "../stores/notifications";
import { useWorkspacesStore } from "../stores/workspaces";
import { ActivityRoute } from "./activity";

const navigate = vi.fn();
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigate,
}));

const snapshot: ActivitySnapshot = {
  totalUnreadMessages: 3,
  items: [
    {
      conversationId: "channel-beta",
      conversationType: "group",
      conversationName: "General",
      workspaceId: "workspace-beta",
      workspaceName: "Beta",
      unreadCount: 3,
      latestMessage: {
        id: "message-3",
        threadId: null,
        threadTitle: null,
        senderId: "user-alice",
        senderName: "Alice",
        senderType: "human",
        content: "The launch checklist is ready",
        createdAt: "2026-09-01T10:00:00.000Z",
      },
    },
  ],
};

const invite: WorkspaceInvite = {
  id: "invite-1",
  workspaceId: "workspace-gamma",
  workspaceName: "Gamma",
  inviterId: "user-bob",
  inviterName: "Bob",
  createdAt: "2026-09-01T09:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  useActivityStore.getState().reset();
  useActivityStore.setState({
    ...snapshot,
    loading: false,
    error: null,
    fetchActivity: vi.fn().mockResolvedValue(undefined),
    markConversationRead: vi.fn().mockResolvedValue(undefined),
    markAllRead: vi.fn().mockResolvedValue(undefined),
  });
  useNotificationsStore.getState().reset();
  useNotificationsStore.setState({
    notifications: [{ type: "workspace_invite", invite }],
    loading: false,
    error: null,
    fetchNotifications: vi.fn().mockResolvedValue(undefined),
  });
  useWorkspacesStore.setState({
    workspaces: [
      {
        id: "workspace-alpha",
        name: "Alpha",
        role: "owner",
        createdAt: "2026-09-01T08:00:00.000Z",
        updatedAt: "2026-09-01T08:00:00.000Z",
      },
      {
        id: "workspace-beta",
        name: "Beta",
        role: "member",
        createdAt: "2026-09-01T08:00:00.000Z",
        updatedAt: "2026-09-01T08:00:00.000Z",
      },
    ],
    activeWorkspace: {
      id: "workspace-alpha",
      name: "Alpha",
      createdAt: "2026-09-01T08:00:00.000Z",
      updatedAt: "2026-09-01T08:00:00.000Z",
      channels: [],
      members: [],
    },
    selectWorkspace: vi.fn().mockResolvedValue(true),
  });
});

describe("ActivityRoute", () => {
  it("combines unread messages across workspaces with pending requests", () => {
    render(<ActivityRoute />);

    expect(screen.getByRole("heading", { name: "Activity" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Unread messages" })).toBeInTheDocument();
    expect(screen.getByText("Beta")).toBeInTheDocument();
    expect(screen.getByText("# General")).toBeInTheDocument();
    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(screen.getByText("The launch checklist is ready")).toBeInTheDocument();
    expect(screen.getByText("3 unread")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Requests" })).toBeInTheDocument();
    expect(screen.getByText("Join Gamma")).toBeInTheDocument();
  });

  it("opens activity in its workspace without marking it read prematurely", async () => {
    const user = userEvent.setup();
    render(<ActivityRoute />);

    await user.click(
      screen.getByRole("button", { name: "Open # General in Beta" }),
    );

    expect(useWorkspacesStore.getState().selectWorkspace).toHaveBeenCalledWith(
      "workspace-beta",
    );
    expect(navigate).toHaveBeenCalledWith({
      to: "/channel/$id",
      params: { id: "channel-beta" },
    });
    expect(
      useActivityStore.getState().markConversationRead,
    ).not.toHaveBeenCalled();
  });

  it("deep-links task activity to its Hermes thread", async () => {
    useActivityStore.setState({
      items: [
        {
          ...snapshot.items[0],
          conversationType: "direct",
          conversationName: "Koda",
          latestMessage: {
            ...snapshot.items[0].latestMessage,
            threadId: "thread-1",
            threadTitle: "Deploy preview",
          },
        },
      ],
    });
    render(<ActivityRoute />);

    await userEvent.click(
      screen.getByRole("button", { name: "Open Koda in Beta" }),
    );

    expect(navigate).toHaveBeenCalledWith({
      to: "/dm/$id",
      params: { id: "channel-beta" },
      search: { threadId: "thread-1" },
    });
  });

  it("keeps the item unread when its workspace cannot be opened", async () => {
    useWorkspacesStore.setState({
      selectWorkspace: vi.fn().mockResolvedValue(false),
    });
    render(<ActivityRoute />);

    await userEvent.click(
      screen.getByRole("button", { name: "Open # General in Beta" }),
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Couldn't open Beta",
    );
    expect(navigate).not.toHaveBeenCalled();
    expect(
      useActivityStore.getState().markConversationRead,
    ).not.toHaveBeenCalled();
  });

  it("marks one conversation or the whole inbox read on demand", async () => {
    const user = userEvent.setup();
    render(<ActivityRoute />);

    await user.click(screen.getByRole("button", { name: "Mark General as read" }));
    expect(
      useActivityStore.getState().markConversationRead,
    ).toHaveBeenCalledWith("channel-beta");

    await user.click(screen.getByRole("button", { name: "Mark all as read" }));
    expect(useActivityStore.getState().markAllRead).toHaveBeenCalledTimes(1);
  });
});
