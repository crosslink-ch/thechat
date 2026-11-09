import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, WorkspaceWithDetails } from "@thechat/shared";
import { Avatar } from "./Avatar";
import { SharedChatMessage } from "./SharedChatMessage";
import { MentionList } from "./MentionList";
import { useAuthStore } from "../stores/auth";
import { useWorkspacesStore } from "../stores/workspaces";

vi.mock("./BotFace", () => ({ BotFace: () => <span data-testid="bot-face" /> }));

beforeEach(() => {
  useAuthStore.setState({ user: null, token: null });
  useWorkspacesStore.setState({ activeWorkspace: null });
});

describe("shared Avatar", () => {
  it("falls back on failure, tries a replacement and keeps the online dot unclipped", () => {
    const view = (picture: string | null) => (
      <Avatar name="Jane Rivera" colorKey="jane" picture={picture}>
        <span data-testid="online" />
      </Avatar>
    );
    const { container, rerender } = render(view(null));
    expect(screen.getByText("J")).toBeInTheDocument();
    rerender(view("data:image/png;base64,first"));
    expect(container.querySelector("img")).toHaveAttribute("src", "data:image/png;base64,first");
    expect(screen.getByTestId("online").parentElement).not.toHaveClass("overflow-hidden");
    fireEvent.error(container.querySelector("img")!);
    expect(screen.getByText("J")).toBeInTheDocument();
    rerender(view("data:image/png;base64,replacement"));
    expect(container.querySelector("img")).toHaveAttribute("src", "data:image/png;base64,replacement");
    rerender(view(null));
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("J")).toBeInTheDocument();
  });

  it("does not replace a bot's shape or navy fallback with a human picture", () => {
    const { container, rerender } = render(<Avatar name="Agent" bot picture="data:image/png;base64,no" botAvatar={{ shape: "square", color: "#FDCB6E" }} />);
    expect(screen.getByTestId("bot-face")).toBeInTheDocument();
    expect(container.querySelector("img")).toBeNull();
    rerender(<Avatar name="Agent" bot picture="data:image/png;base64,no" />);
    expect(screen.getByText("A")).toHaveClass("bg-accent-hover");
    expect(container.querySelector("img")).toBeNull();
  });

  it("updates earlier channel/DM message rows when workspace pictures change, including removal", () => {
    const member = { userId: "jane", user: { id: "jane", name: "Jane", avatar: "data:image/png;base64,first", type: "human", email: null }, role: "member", joinedAt: "2026-01-01T00:00:00Z" };
    const workspace = { id: "workspace", members: [member], channels: [] } as unknown as WorkspaceWithDetails;
    useWorkspacesStore.setState({ activeWorkspace: workspace });
    const message = { id: "message", conversationId: "conversation", senderId: "jane", senderName: "Jane", senderType: "human", content: "Hello", createdAt: "2026-01-01T00:00:00Z" } as ChatMessage;
    const { container } = render(<SharedChatMessage message={message} merged={false}>Hello</SharedChatMessage>);
    expect(container.querySelector("img")).toHaveAttribute("src", member.user.avatar);
    act(() => useWorkspacesStore.setState({ activeWorkspace: { ...workspace, members: [{ ...workspace.members[0]!, user: { ...workspace.members[0]!.user, avatar: "data:image/png;base64,new" } }] } }));
    expect(container.querySelector("img")).toHaveAttribute("src", "data:image/png;base64,new");
    act(() => useWorkspacesStore.setState({ activeWorkspace: { ...workspace, members: [{ ...workspace.members[0]!, user: { ...workspace.members[0]!.user, avatar: null } }] } }));
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("J")).toBeInTheDocument();
  });

  it("shows pictures in mention suggestions without changing the selection payload", () => {
    const item = { id: "jane", label: "Jane", type: "human" as const, picture: "data:image/png;base64,portrait" };
    const command = vi.fn();
    const { container } = render(<MentionList items={[item]} command={command} />);
    expect(container.querySelector("img")).toHaveAttribute("src", item.picture);
    fireEvent.click(screen.getByRole("button", { name: "Jane" }));
    expect(command).toHaveBeenCalledWith(item);
  });
});
