import { useEffect } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { ChannelRoute } from "./channel";

const { chat, read, mark, view, mount, navigate, focus, route } = vi.hoisted(() => ({
  chat: vi.fn((_options: unknown) => ({ messages: [], loading: false })),
  read: vi.fn(), mark: vi.fn(), view: vi.fn(), mount: vi.fn(),
  navigate: vi.fn().mockResolvedValue(undefined), focus: vi.fn(),
  route: { search: {} as { messageId?: string; threadId?: string; jump?: string } },
}));
vi.mock("@tanstack/react-router", () => ({
  useParams: () => ({ id: "general" }),
  useSearch: () => route.search,
  useNavigate: () => navigate,
}));
vi.mock("../stores/auth", () => ({
  useAuthStore: (selector: (state: unknown) => unknown) => selector({ token: "token", user: { id: "alice" } }),
}));
vi.mock("../stores/workspaces", () => ({
  useWorkspacesStore: (selector: (state: unknown) => unknown) => selector({ activeWorkspace: null }),
}));
vi.mock("../stores/websocket", () => ({
  useWebSocketStore: (selector: (state: unknown) => unknown) => selector({ sendMessage: vi.fn() }),
}));
vi.mock("../stores/input-focus", () => ({ requestInputBarFocus: focus }));
vi.mock("../hooks/useChannelChat", () => ({ useChannelChat: chat }));
vi.mock("../hooks/usePersistConversationRead", () => ({ usePersistConversationRead: read }));
vi.mock("../stores/conversations", () => ({
  useConversationsStore: { getState: () => ({ markChannelRead: mark }) },
}));
vi.mock("../components/ChannelChatView", () => ({
  ChannelChatView: (props: unknown) => {
    view(props);
    useEffect(() => { mount(); }, []);
    return <p>Latest chat</p>;
  },
}));
vi.mock("../components/MessageContextView", () => ({
  MessageContextView: ({ messageId }: { messageId: string }) => <p>Context {messageId}</p>,
}));
beforeEach(() => {
  vi.clearAllMocks();
  route.search = {};
});

it("opens channel message context without fetching or consuming latest unread", () => {
  route.search = { messageId: "old-message", threadId: "task-1" };
  render(<ChannelRoute />);
  expect(screen.getByText("Context old-message")).toBeInTheDocument();
  expect(chat).not.toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
  expect(mark).not.toHaveBeenCalled();
});

it("preserves plain channel history and existing draft and scroll keys", () => {
  render(<ChannelRoute />);
  expect(chat).toHaveBeenLastCalledWith(expect.objectContaining({ conversationId: "general" }));
  expect(chat.mock.calls.at(-1)?.[0]).not.toEqual(expect.objectContaining({ unthreadedOnly: true }));
  expect(view).toHaveBeenLastCalledWith(expect.objectContaining({
    scrollKey: "general", draftKey: "account:alice:channel:general",
  }));
  expect(screen.queryByRole("button", { name: "Back to channel" })).not.toBeInTheDocument();
});

it("scopes task history and sends through the channel hook with separate draft and scroll keys", () => {
  route.search = { threadId: "task-1" };
  render(<ChannelRoute />);
  expect(chat).toHaveBeenLastCalledWith(expect.objectContaining({ conversationId: "general", threadId: "task-1" }));
  expect(view).toHaveBeenLastCalledWith(expect.objectContaining({
    scrollKey: "general:thread:task-1", draftKey: "account:alice:channel:general:thread:task-1",
  }));
  expect(screen.getByRole("heading", { name: "Task" })).toBeInTheDocument();
});

it("remounts the live composer when switching between tasks and the parent without a jump", () => {
  route.search = { threadId: "task-1" };
  const { rerender } = render(<ChannelRoute />);
  expect(mount).toHaveBeenCalledTimes(1);
  route.search = { threadId: "task-2" };
  rerender(<ChannelRoute />);
  expect(mount).toHaveBeenCalledTimes(2);
  route.search = {};
  rerender(<ChannelRoute />);
  expect(mount).toHaveBeenCalledTimes(3);
});

it("returns to the parent channel with a fresh jump, cleared context and composer focus", async () => {
  route.search = { threadId: "task-1", jump: "old-jump" };
  render(<ChannelRoute />);
  fireEvent.click(screen.getByRole("button", { name: "Back to channel" }));
  await waitFor(() => expect(focus).toHaveBeenCalledOnce());
  expect(navigate).toHaveBeenCalledWith({
    to: "/channel/$id", params: { id: "general" },
    search: { threadId: undefined, messageId: undefined, jump: expect.any(String) },
  });
  expect(navigate.mock.calls[0][0].search.jump).not.toBe("old-jump");
});
