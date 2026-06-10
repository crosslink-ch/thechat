import { describe, expect, it, beforeAll, beforeEach, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
