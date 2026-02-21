import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Sidebar } from "./Sidebar";
import type { Conversation } from "../core/types";
import type {
  AuthUser,
  WorkspaceListItem,
  WorkspaceWithDetails,
} from "@thechat/shared";

const conversations: Conversation[] = [
  { id: "c1", title: "Chat 1", created_at: "2026-01-01", updated_at: "2026-01-01" },
  { id: "c2", title: "Chat 2", created_at: "2026-01-02", updated_at: "2026-01-02" },
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

const noop = () => {};

describe("Sidebar", () => {
  it("renders correctly when not logged in", () => {
    render(
      <Sidebar
        open={true}
        conversations={conversations}
        currentId={undefined}
        user={null}
        workspaces={[]}
        activeWorkspace={null}
        onClose={noop}
        onNewChat={noop}
        onSelectConversation={noop}
        onLoginClick={noop}
        onLogout={noop}
        onSelectWorkspace={noop}
        onOpenWorkspaceModal={noop}
      />
    );

    expect(screen.getByText("Log in")).toBeInTheDocument();
    expect(screen.getByText("+ New Chat")).toBeInTheDocument();
    expect(screen.getByText("Chat 1")).toBeInTheDocument();
    expect(screen.getByText("Chat 2")).toBeInTheDocument();
    // No workspace switcher
    expect(screen.queryByText("Select workspace")).not.toBeInTheDocument();
  });

  it("renders workspace switcher when logged in", () => {
    render(
      <Sidebar
        open={true}
        conversations={conversations}
        currentId={undefined}
        user={user}
        workspaces={workspaceList}
        activeWorkspace={null}
        onClose={noop}
        onNewChat={noop}
        onSelectConversation={noop}
        onLoginClick={noop}
        onLogout={noop}
        onSelectWorkspace={noop}
        onOpenWorkspaceModal={noop}
      />
    );

    expect(screen.getByText("Select workspace")).toBeInTheDocument();
    expect(screen.getByText("Test User")).toBeInTheDocument();
    expect(screen.getByText("Log out")).toBeInTheDocument();
  });

  it("renders channels and members when workspace is active", () => {
    render(
      <Sidebar
        open={true}
        conversations={conversations}
        currentId={undefined}
        user={user}
        workspaces={workspaceList}
        activeWorkspace={activeWorkspace}
        onClose={noop}
        onNewChat={noop}
        onSelectConversation={noop}
        onLoginClick={noop}
        onLogout={noop}
        onSelectWorkspace={noop}
        onOpenWorkspaceModal={noop}
      />
    );

    // Workspace name shown in switcher
    expect(screen.getByText("Team Alpha")).toBeInTheDocument();
    // Channel shown
    expect(screen.getByText("Channels")).toBeInTheDocument();
    expect(screen.getByText(/general/)).toBeInTheDocument();
    // DMs shown (other members only)
    expect(screen.getByText("Direct Messages")).toBeInTheDocument();
    expect(screen.getByText("Alice")).toBeInTheDocument();
    // Agent Chats section
    expect(screen.getByText("Agent Chats")).toBeInTheDocument();
  });

  it("shows Agent Chats section in all modes", () => {
    // Not logged in
    const { unmount } = render(
      <Sidebar
        open={true}
        conversations={conversations}
        currentId={undefined}
        user={null}
        workspaces={[]}
        activeWorkspace={null}
        onClose={noop}
        onNewChat={noop}
        onSelectConversation={noop}
        onLoginClick={noop}
        onLogout={noop}
        onSelectWorkspace={noop}
        onOpenWorkspaceModal={noop}
      />
    );
    expect(screen.getByText("Agent Chats")).toBeInTheDocument();
    unmount();

    // Logged in, no workspace
    const { unmount: unmount2 } = render(
      <Sidebar
        open={true}
        conversations={conversations}
        currentId={undefined}
        user={user}
        workspaces={workspaceList}
        activeWorkspace={null}
        onClose={noop}
        onNewChat={noop}
        onSelectConversation={noop}
        onLoginClick={noop}
        onLogout={noop}
        onSelectWorkspace={noop}
        onOpenWorkspaceModal={noop}
      />
    );
    expect(screen.getByText("Agent Chats")).toBeInTheDocument();
    unmount2();

    // Logged in, with workspace
    render(
      <Sidebar
        open={true}
        conversations={conversations}
        currentId={undefined}
        user={user}
        workspaces={workspaceList}
        activeWorkspace={activeWorkspace}
        onClose={noop}
        onNewChat={noop}
        onSelectConversation={noop}
        onLoginClick={noop}
        onLogout={noop}
        onSelectWorkspace={noop}
        onOpenWorkspaceModal={noop}
      />
    );
    expect(screen.getByText("Agent Chats")).toBeInTheDocument();
  });
});
