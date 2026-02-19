import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MessageBubble, StreamingBubble } from "./MessageBubble";
import type { Message } from "./core/types";

const userMsg: Message = {
  id: "1",
  conversation_id: "c1",
  role: "user",
  parts: [{ type: "text", text: "Hello world" }],
  created_at: "2026-01-01T00:00:00Z",
};

const assistantMsg: Message = {
  id: "2",
  conversation_id: "c1",
  role: "assistant",
  parts: [
    { type: "reasoning", text: "Let me think about this..." },
    { type: "text", text: "Hi there!" },
  ],
  created_at: "2026-01-01T00:00:01Z",
};

const assistantMsgNoReasoning: Message = {
  id: "3",
  conversation_id: "c1",
  role: "assistant",
  parts: [{ type: "text", text: "Quick reply" }],
  created_at: "2026-01-01T00:00:02Z",
};

describe("MessageBubble", () => {
  it("renders user message content", () => {
    render(<MessageBubble message={userMsg} />);
    expect(screen.getByText("Hello world")).toBeInTheDocument();
  });

  it("applies user class for user messages", () => {
    const { container } = render(<MessageBubble message={userMsg} />);
    expect(container.querySelector(".message-user")).not.toBeNull();
  });

  it("applies assistant class for assistant messages", () => {
    const { container } = render(<MessageBubble message={assistantMsg} />);
    expect(container.querySelector(".message-assistant")).not.toBeNull();
  });

  it("does not show reasoning toggle for user messages", () => {
    render(<MessageBubble message={userMsg} />);
    expect(screen.queryByText("Show Thinking")).not.toBeInTheDocument();
  });

  it("does not show reasoning toggle for assistant without reasoning", () => {
    render(<MessageBubble message={assistantMsgNoReasoning} />);
    expect(screen.queryByText("Show Thinking")).not.toBeInTheDocument();
  });

  it("shows reasoning toggle for assistant messages with reasoning", () => {
    render(<MessageBubble message={assistantMsg} />);
    expect(screen.getByText("Show Thinking")).toBeInTheDocument();
  });

  it("reasoning is hidden by default", () => {
    render(<MessageBubble message={assistantMsg} />);
    expect(
      screen.queryByText("Let me think about this..."),
    ).not.toBeInTheDocument();
  });

  it("toggles reasoning content on click", () => {
    render(<MessageBubble message={assistantMsg} />);

    fireEvent.click(screen.getByText("Show Thinking"));
    expect(
      screen.getByText("Let me think about this..."),
    ).toBeInTheDocument();
    expect(screen.getByText("Hide Thinking")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Hide Thinking"));
    expect(
      screen.queryByText("Let me think about this..."),
    ).not.toBeInTheDocument();
  });

  it("renders tool-call part", () => {
    const msg: Message = {
      id: "4",
      conversation_id: "c1",
      role: "assistant",
      parts: [
        { type: "tool-call", toolCallId: "tc1", toolName: "get_weather", args: { city: "Paris" } },
      ],
      created_at: "2026-01-01T00:00:03Z",
    };
    render(<MessageBubble message={msg} />);
    expect(screen.getByText("Tool Call: get_weather")).toBeInTheDocument();
    expect(screen.getByText(/"city": "Paris"/)).toBeInTheDocument();
  });

  it("renders tool-result part", () => {
    const msg: Message = {
      id: "5",
      conversation_id: "c1",
      role: "assistant",
      parts: [
        { type: "tool-result", toolCallId: "tc1", toolName: "get_weather", result: { temp: 20 } },
      ],
      created_at: "2026-01-01T00:00:04Z",
    };
    render(<MessageBubble message={msg} />);
    expect(screen.getByText("Result: get_weather")).toBeInTheDocument();
    expect(screen.getByText(/"temp": 20/)).toBeInTheDocument();
  });

  it("renders tool-result error state", () => {
    const msg: Message = {
      id: "6",
      conversation_id: "c1",
      role: "assistant",
      parts: [
        {
          type: "tool-result",
          toolCallId: "tc1",
          toolName: "broken_tool",
          result: { error: "Something went wrong" },
          isError: true,
        },
      ],
      created_at: "2026-01-01T00:00:05Z",
    };
    const { container } = render(<MessageBubble message={msg} />);
    expect(screen.getByText("Error: broken_tool")).toBeInTheDocument();
    expect(container.querySelector(".tool-result-error")).not.toBeNull();
  });
});

describe("StreamingBubble", () => {
  it("shows typing indicator when no content or reasoning", () => {
    const { container } = render(<StreamingBubble parts={[]} />);
    expect(container.querySelector(".typing-indicator")).not.toBeNull();
  });

  it("shows content when available", () => {
    render(<StreamingBubble parts={[{ type: "text", text: "Responding..." }]} />);
    expect(screen.getByText("Responding...")).toBeInTheDocument();
  });

  it("shows reasoning when available", () => {
    render(
      <StreamingBubble parts={[{ type: "reasoning", text: "Thinking hard..." }]} />,
    );
    expect(screen.getByText("Thinking hard...")).toBeInTheDocument();
  });

  it("reasoning is open by default during streaming", () => {
    render(
      <StreamingBubble parts={[{ type: "reasoning", text: "Working on it..." }]} />,
    );
    expect(screen.getByText("Working on it...")).toBeInTheDocument();
    expect(screen.getByText("Hide Thinking")).toBeInTheDocument();
  });

  it("hides typing indicator when reasoning is present", () => {
    const { container } = render(
      <StreamingBubble parts={[{ type: "reasoning", text: "Thinking..." }]} />,
    );
    expect(container.querySelector(".typing-indicator")).toBeNull();
  });

  it("renders tool-call part during streaming", () => {
    render(
      <StreamingBubble
        parts={[
          { type: "tool-call", toolCallId: "tc1", toolName: "search", args: { q: "test" } },
        ]}
      />,
    );
    expect(screen.getByText("Tool Call: search")).toBeInTheDocument();
  });
});
