import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import type { ChatMessage } from "@thechat/shared";
import { MessageContextView } from "./MessageContextView";
import { useActivityStore } from "../stores/activity";
import { useAuthStore } from "../stores/auth";
const { context, navigate } = vi.hoisted(() => ({
  context: vi.fn(),
  navigate: vi.fn(),
}));
vi.mock("../lib/search-api", () => ({ getMessageContext: context }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));
const messages: ChatMessage[] = Array.from({ length: 41 }, (_, index) => ({
  id: `old-${index}`,
  conversationId: "koda",
  threadId: "ancient-task",
  senderId: "alice",
  senderName: "Alice",
  senderType: "human",
  content: `History ${index}`,
  createdAt: "2025-01-01T10:00:00Z",
}));
const data = {
  conversationId: "koda",
  threadId: "ancient-task",
  messages,
  hasOlder: true,
  hasNewer: true,
};
let observerCallback: IntersectionObserverCallback;
const observe = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: IntersectionObserverCallback) {
        observerCallback = callback;
      }
      observe = observe;
      unobserve = vi.fn();
      disconnect = vi.fn();
    },
  );
  Element.prototype.scrollIntoView = vi.fn();
  context.mockResolvedValue(data);
  useAuthStore.setState({ token: "token" });
  useActivityStore.setState({
    markConversationRead: vi.fn().mockResolvedValue(undefined),
  });
});
afterEach(() => vi.unstubAllGlobals());
it("loads a bounded old-message window, highlights exact target, reads only intersecting messages and returns to latest task", async () => {
  const view = render(
    <MessageContextView
      conversationId="koda"
      threadId="ancient-task"
      messageId="old-20"
      route="/dm/$id"
    />,
  );
  expect(await screen.findByText("History 20")).toBeInTheDocument();
  expect(context).toHaveBeenCalledExactlyOnceWith("old-20", "token");
  const highlighted = screen.getByLabelText("Selected search message");
  expect(highlighted).toHaveAttribute("data-highlighted-message", "old-20");
  expect(highlighted).toHaveFocus();
  expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({
    block: "center",
  });
  expect(
    useActivityStore.getState().markConversationRead,
  ).not.toHaveBeenCalled();
  const target = view.container.querySelector("[data-message-id=old-20]")!;
  await act(async () =>
    observerCallback(
      [
        { target, isIntersecting: true, intersectionRatio: 1 },
      ] as IntersectionObserverEntry[],
      {} as IntersectionObserver,
    ),
  );
  expect(
    useActivityStore.getState().markConversationRead,
  ).toHaveBeenCalledExactlyOnceWith("koda", ["old-20"]);
  expect(screen.queryByText("Load earlier messages")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Back to latest" }));
  expect(navigate).toHaveBeenCalledWith(
    expect.objectContaining({
      to: "/dm/$id",
      params: { id: "koda" },
      search: expect.objectContaining({
        threadId: "ancient-task",
        messageId: undefined,
      }),
    }),
  );
});
it("does not render a mismatched or revoked scope and never marks that window read", async () => {
  context.mockResolvedValue({ ...data, conversationId: "other" });
  render(
    <MessageContextView
      conversationId="koda"
      threadId="ancient-task"
      messageId="old-20"
      route="/dm/$id"
    />,
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(/unavailable/);
  expect(screen.queryByText("History 20")).not.toBeInTheDocument();
  expect(
    useActivityStore.getState().markConversationRead,
  ).not.toHaveBeenCalled();
});
it("ignores late context after target changes", async () => {
  let resolve!: (value: typeof data) => void;
  context.mockReturnValueOnce(
    new Promise((r) => {
      resolve = r;
    }),
  );
  const view = render(
    <MessageContextView
      conversationId="koda"
      threadId="ancient-task"
      messageId="old-20"
      route="/dm/$id"
    />,
  );
  context.mockResolvedValue({
    ...data,
    messages: [{ ...messages[0], id: "new-target", content: "New context" }],
  });
  view.rerender(
    <MessageContextView
      conversationId="koda"
      threadId="ancient-task"
      messageId="new-target"
      route="/dm/$id"
    />,
  );
  await act(async () => resolve(data));
  await waitFor(() =>
    expect(screen.getByText("New context")).toBeInTheDocument(),
  );
  expect(screen.queryByText("History 20")).not.toBeInTheDocument();
});
