import { describe, expect, it, beforeAll, beforeEach, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type {
  BotInvocationProgressEventPublic,
  BotInvocationPublic,
  ChatMessage,
} from "@thechat/shared";
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

describe("ChannelChatView Hermes progress", () => {
  it("hides the generic typing indicator while Hermes progress is active", () => {
    render(
      <ChannelChatView
        messages={[]}
        loading={false}
        typingUsers={new Map([["bot-user-1", "Koda"]])}
        progressInvocations={[invocation({ status: "running" })]}
        progressEvents={[]}
        onSend={() => {}}
      />,
    );

    expect(screen.getByText("Koda is working")).toBeInTheDocument();
    expect(screen.queryByText("Koda is typing...")).toBeNull();
  });

  it("shows the generic typing indicator when there is no active progress", () => {
    render(
      <ChannelChatView
        messages={[]}
        loading={false}
        typingUsers={new Map([["bot-user-1", "Koda"]])}
        progressInvocations={[]}
        progressEvents={[]}
        onSend={() => {}}
      />,
    );

    expect(screen.getByText("Koda is typing...")).toBeInTheDocument();
  });

  it("can suppress generic typing even when visible progress is scoped out", () => {
    render(
      <ChannelChatView
        messages={[]}
        loading={false}
        typingUsers={new Map([["bot-user-1", "Koda"]])}
        progressInvocations={[]}
        progressEvents={[]}
        typingSuppressedUserIds={["bot-user-1"]}
        onSend={() => {}}
      />,
    );

    expect(screen.queryByText("Koda is typing...")).toBeNull();
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
        progressInvocations={[]}
        progressEvents={[]}
        onSend={() => {}}
      />,
    );

    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
  });

  it("does not jump for Hermes progress props with unchanged visible content", () => {
    const activeInvocation = invocation({ updatedAt: "2026-01-01T00:00:00.000Z" });
    const activeEvent = progressEvent({
      id: "event-active-1",
      invocationId: activeInvocation.id,
      label: "Reading files",
    });
    const firstMessage = message();
    const props = {
      messages: [firstMessage],
      loading: false,
      typingUsers: new Map<string, string>(),
      onSend: () => {},
    };

    const { rerender } = render(
      <ChannelChatView
        {...props}
        progressInvocations={[activeInvocation]}
        progressEvents={[activeEvent]}
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
        progressInvocations={[{ ...activeInvocation }]}
        progressEvents={[{ ...activeEvent }]}
      />,
    );

    expect(scrollToMock).not.toHaveBeenCalled();
  });

  it("leaves scroll position alone when visible Hermes progress updates after the user scrolls up", () => {
    const activeInvocation = invocation({ updatedAt: "2026-01-01T00:00:00.000Z" });
    const firstMessage = message();
    const props = {
      messages: [firstMessage],
      loading: false,
      typingUsers: new Map<string, string>(),
      progressInvocations: [activeInvocation],
      onSend: () => {},
    };

    const { rerender } = render(
      <ChannelChatView
        {...props}
        progressEvents={[
          progressEvent({
            id: "event-active-1",
            invocationId: activeInvocation.id,
            label: "Reading files",
          }),
        ]}
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
        progressEvents={[
          progressEvent({
            id: "event-active-1",
            invocationId: activeInvocation.id,
            label: "Reading files",
          }),
          progressEvent({
            id: "event-active-2",
            invocationId: activeInvocation.id,
            label: "Running command",
            sequence: 2,
          }),
        ]}
      />,
    );

    expect(scrollToMock).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /jump to bottom/i })).toBeInTheDocument();
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

function invocation(
  overrides: Partial<BotInvocationPublic> = {},
): BotInvocationPublic {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    id: "invocation-1",
    botId: "bot-1",
    botUserId: "bot-user-1",
    botName: "Koda",
    botKind: "hermes",
    conversationId: "conversation-1",
    threadId: null,
    triggerMessageId: "message-1",
    responseMessageId: null,
    adapterKind: "hermes",
    status: "running",
    externalRunId: null,
    requestJson: null,
    responseJson: null,
    error: null,
    startedAt: now,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function progressEvent(
  overrides: Partial<BotInvocationProgressEventPublic> = {},
): BotInvocationProgressEventPublic {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    id: "event-1",
    invocationId: "invocation-1",
    botId: "bot-1",
    conversationId: "conversation-1",
    threadId: null,
    sequence: 1,
    type: "tool.running",
    status: "running",
    toolCallId: null,
    toolName: null,
    label: "Working",
    preview: null,
    payload: null,
    occurredAt: now,
    createdAt: now,
    ...overrides,
  };
}
