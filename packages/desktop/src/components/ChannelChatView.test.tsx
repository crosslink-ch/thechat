import { describe, expect, it, beforeAll, beforeEach, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ChatMessage } from "@thechat/shared";
import { ChannelChatView } from "./ChannelChatView";

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

let scrollToMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.mocked(Element.prototype.scrollIntoView).mockClear();
  scrollToMock = vi.fn(function scrollTo(
    this: Element,
    options?: ScrollToOptions | number,
    y?: number,
  ) {
    const top = typeof options === "object" ? options.top : y;
    if (typeof top === "number") {
      this.scrollTop = top;
    }
  });
  Element.prototype.scrollTo =
    scrollToMock as unknown as typeof Element.prototype.scrollTo;
});

describe("ChannelChatView", () => {
  it("visually merges adjacent messages from the same sender within five minutes", () => {
    render(
      <ChannelChatView
        messages={[
          message({
            id: "message-1",
            content: "First message",
            createdAt: "2026-01-01T10:00:00.000Z",
          }),
          message({
            id: "message-2",
            content: "Second message",
            createdAt: "2026-01-01T10:04:00.000Z",
          }),
        ]}
        loading={false}
        typingUsers={new Map()}
        onSend={() => {}}
      />,
    );

    expect(screen.getAllByText("Koda")).toHaveLength(1);
    const firstRow = screen.getByText("First message").closest("[data-message-id]");
    const secondRow = screen.getByText("Second message").closest("[data-message-id]");
    expect(firstRow).toHaveAttribute("data-message-grouped", "false");
    expect(firstRow?.querySelector("[data-message-header]")).not.toBeNull();
    expect(secondRow).toHaveAttribute("data-message-grouped", "true");
    expect(secondRow?.querySelector("[data-message-header]")).toBeNull();
    expect(secondRow).toHaveClass("py-0.5");
    if (!(secondRow instanceof HTMLElement)) {
      throw new Error("Grouped message row not found");
    }
    const hoverTime = within(secondRow).getByLabelText(/sent/i);
    expect(hoverTime).toHaveClass("opacity-0", "active:opacity-100");
    expect(hoverTime).toHaveAttribute("tabindex", "0");
    expect(hoverTime).toHaveAttribute(
      "datetime",
      "2026-01-01T10:04:00.000Z",
    );
  });

  it("keeps reactions interactive on a grouped message", async () => {
    const onSetReaction = vi.fn().mockResolvedValue(undefined);
    render(
      <ChannelChatView
        messages={[
          message({
            id: "message-1",
            content: "First message",
            createdAt: "2026-01-01T10:00:00.000Z",
          }),
          message({
            id: "message-2",
            content: "Second message",
            createdAt: "2026-01-01T10:04:00.000Z",
            reactions: [
              {
                emoji: "👍",
                count: 1,
                reactedByMe: true,
                userNames: ["Bruno"],
              },
            ],
          }),
        ]}
        loading={false}
        typingUsers={new Map()}
        onSend={() => {}}
        onSetReaction={onSetReaction}
      />,
    );

    const groupedRow = screen
      .getByText("Second message")
      .closest<HTMLElement>("[data-message-id]");
    if (!groupedRow) throw new Error("Grouped message row not found");
    expect(groupedRow).toHaveAttribute("data-message-grouped", "true");

    fireEvent.click(
      within(groupedRow).getByRole("button", { name: "👍 1 reaction" }),
    );
    await waitFor(() =>
      expect(onSetReaction).toHaveBeenCalledWith("message-2", "👍", false),
    );
  });

  it("shows the generic typing indicator", () => {
    render(
      <ChannelChatView
        messages={[]}
        loading={false}
        typingUsers={new Map([["user-1", "Koda"]])}
        onSend={() => {}}
      />,
    );

    expect(screen.getByText("Koda is typing...")).toBeInTheDocument();
  });

  it("shows message send failures as an alert", () => {
    render(
      <ChannelChatView
        messages={[]}
        loading={false}
        sendError="Thread not found"
        typingUsers={new Map()}
        onSend={() => {}}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Message not sent: Thread not found",
    );
  });

  it("does not use scrollIntoView for automatic chat scrolling", () => {
    render(
      <ChannelChatView
        messages={[
          message({
            content: "A long message with display math\n\n\\[x_{t+1}=x_t-\\eta f'(x_t)\\]",
          }),
        ]}
        loading={false}
        typingUsers={new Map()}
        onSend={() => {}}
      />,
    );

    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
  });

  it("leaves scroll position alone when typing updates after the user scrolls up", () => {
    const firstMessage = message();
    const props = {
      messages: [firstMessage],
      loading: false,
      onSend: () => {},
    };

    const { rerender } = render(
      <ChannelChatView
        {...props}
        typingUsers={new Map([["user-1", "Koda"]])}
      />,
    );
    const scroller = screen.getByTestId("channel-chat-scroll");
    makeScrollable(scroller);
    fireEvent.wheel(scroller, { deltaY: -80 });
    fireEvent.scroll(scroller);
    scrollToMock.mockClear();

    rerender(
      <ChannelChatView
        {...props}
        typingUsers={new Map([
          ["user-1", "Koda"],
          ["user-2", "Ada"],
        ])}
      />,
    );

    expect(scrollToMock).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /jump to bottom/i })).toBeInTheDocument();
  });

  it("loads older messages when the user scrolls near the top", async () => {
    const onLoadOlderMessages = vi.fn(() => Promise.resolve());
    render(
      <ChannelChatView
        messages={[message()]}
        loading={false}
        hasOlderMessages
        typingUsers={new Map()}
        onSend={() => {}}
        onLoadOlderMessages={onLoadOlderMessages}
      />,
    );
    const scroller = screen.getByTestId("channel-chat-scroll");
    makeScrollable(scroller);
    scroller.scrollTop = 0;

    fireEvent.scroll(scroller);

    await waitFor(() => {
      expect(onLoadOlderMessages).toHaveBeenCalledTimes(1);
    });
  });

  it("does not request older messages again while a load is in flight", async () => {
    const onLoadOlderMessages = vi.fn(() => new Promise<boolean>(() => {}));
    render(
      <ChannelChatView
        messages={[message()]}
        loading={false}
        hasOlderMessages
        typingUsers={new Map()}
        onSend={() => {}}
        onLoadOlderMessages={onLoadOlderMessages}
      />,
    );
    const scroller = screen.getByTestId("channel-chat-scroll");
    makeScrollable(scroller);
    scroller.scrollTop = 0;

    fireEvent.scroll(scroller);
    fireEvent.scroll(scroller);

    await waitFor(() => {
      expect(onLoadOlderMessages).toHaveBeenCalledTimes(1);
    });
    fireEvent.scroll(scroller);
    expect(onLoadOlderMessages).toHaveBeenCalledTimes(1);
  });

});

function makeScrollable(element: HTMLElement) {
  Object.defineProperty(element, "scrollHeight", {
    configurable: true,
    value: 1000,
  });
  Object.defineProperty(element, "clientHeight", {
    configurable: true,
    value: 300,
  });
  Object.defineProperty(element, "scrollTop", {
    configurable: true,
    writable: true,
    value: 200,
  });
}

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "message-1",
    conversationId: "conversation-1",
    threadId: null,
    senderId: "bot-user-1",
    senderName: "Koda",
    senderType: "bot",
    content: "Message content",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}
