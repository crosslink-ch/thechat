import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ChatMessage, StreamingMessage } from "./ChatMessage";
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

describe("ChatMessage", () => {
  it("renders user message content", () => {
    render(<ChatMessage message={userMsg} />);
    expect(screen.getByText("Hello world")).toBeInTheDocument();
  });

  it("shows 'You' label for user messages", () => {
    render(<ChatMessage message={userMsg} />);
    expect(screen.getByText("You")).toBeInTheDocument();
  });

  it("shows 'AI' label for assistant messages", () => {
    render(<ChatMessage message={assistantMsg} />);
    expect(screen.getByText("AI")).toBeInTheDocument();
  });

  it("applies user class for user messages", () => {
    const { container } = render(<ChatMessage message={userMsg} />);
    expect(container.querySelector(".chat-message-user")).not.toBeNull();
  });

  it("applies assistant class for assistant messages", () => {
    const { container } = render(<ChatMessage message={assistantMsg} />);
    expect(container.querySelector(".chat-message-assistant")).not.toBeNull();
  });

  it("does not show thinking section for user messages", () => {
    const { container } = render(<ChatMessage message={userMsg} />);
    expect(container.querySelector(".thinking-section")).toBeNull();
  });

  it("does not show thinking section for assistant without reasoning or tools", () => {
    const { container } = render(<ChatMessage message={assistantMsgNoReasoning} />);
    expect(container.querySelector(".thinking-section")).toBeNull();
  });

  it("shows thinking section for assistant messages with reasoning", () => {
    render(<ChatMessage message={assistantMsg} />);
    expect(screen.getByText("Thought")).toBeInTheDocument();
  });

  it("reasoning is collapsed by default", () => {
    render(<ChatMessage message={assistantMsg} />);
    expect(
      screen.queryByText("Let me think about this..."),
    ).not.toBeInTheDocument();
  });

  it("toggles reasoning content on click", () => {
    render(<ChatMessage message={assistantMsg} />);

    fireEvent.click(screen.getByText("Thought"));
    expect(
      screen.getByText("Let me think about this..."),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByText("Thought"));
    expect(
      screen.queryByText("Let me think about this..."),
    ).not.toBeInTheDocument();
  });

  it("renders tool-call in collapsed thinking section", () => {
    const msg: Message = {
      id: "4",
      conversation_id: "c1",
      role: "assistant",
      parts: [
        { type: "tool-call", toolCallId: "tc1", toolName: "get_weather", args: { city: "Paris" } },
      ],
      created_at: "2026-01-01T00:00:03Z",
    };
    render(<ChatMessage message={msg} />);
    // Thinking section shows "Used 1 tool"
    expect(screen.getByText("Used 1 tool")).toBeInTheDocument();
    // Tool details are not visible by default (section collapsed)
    expect(screen.queryByText("get_weather")).not.toBeInTheDocument();
  });

  it("shows tool activity details when thinking section is expanded", () => {
    const msg: Message = {
      id: "4",
      conversation_id: "c1",
      role: "assistant",
      parts: [
        { type: "tool-call", toolCallId: "tc1", toolName: "get_weather", args: { city: "Paris" } },
        { type: "tool-result", toolCallId: "tc1", toolName: "get_weather", result: { temp: 20 } },
        { type: "text", text: "It's 20 degrees in Paris." },
      ],
      created_at: "2026-01-01T00:00:03Z",
    };
    render(<ChatMessage message={msg} />);

    // Expand thinking section
    fireEvent.click(screen.getByText("Used 1 tool"));
    expect(screen.getByText("get_weather")).toBeInTheDocument();
    expect(screen.getByText("Done")).toBeInTheDocument();
  });

  it("shows error status for failed tool results", () => {
    const msg: Message = {
      id: "6",
      conversation_id: "c1",
      role: "assistant",
      parts: [
        { type: "tool-call", toolCallId: "tc1", toolName: "broken_tool", args: {} },
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
    render(<ChatMessage message={msg} />);

    // Expand thinking section
    fireEvent.click(screen.getByText("Used 1 tool"));
    expect(screen.getByText("Error")).toBeInTheDocument();
    expect(screen.getByText("broken_tool")).toBeInTheDocument();
  });

  it("shows combined label for reasoning and tools", () => {
    const msg: Message = {
      id: "7",
      conversation_id: "c1",
      role: "assistant",
      parts: [
        { type: "reasoning", text: "Hmm..." },
        { type: "tool-call", toolCallId: "tc1", toolName: "search", args: { q: "test" } },
        { type: "tool-result", toolCallId: "tc1", toolName: "search", result: "found" },
        { type: "text", text: "Here you go." },
      ],
      created_at: "2026-01-01T00:00:06Z",
    };
    render(<ChatMessage message={msg} />);
    expect(screen.getByText("Thought and used 1 tool")).toBeInTheDocument();
  });
});

describe("StreamingMessage", () => {
  it("shows typing indicator when no content or reasoning", () => {
    const { container } = render(<StreamingMessage parts={[]} />);
    expect(container.querySelector(".typing-indicator")).not.toBeNull();
  });

  it("shows AI label", () => {
    render(<StreamingMessage parts={[]} />);
    expect(screen.getByText("AI")).toBeInTheDocument();
  });

  it("shows content when available", () => {
    render(<StreamingMessage parts={[{ type: "text", text: "Responding..." }]} />);
    expect(screen.getByText("Responding...")).toBeInTheDocument();
  });

  it("shows reasoning when available (thinking section open by default)", () => {
    render(
      <StreamingMessage parts={[{ type: "reasoning", text: "Thinking hard..." }]} />,
    );
    expect(screen.getByText("Thinking hard...")).toBeInTheDocument();
  });

  it("thinking section is open by default during streaming", () => {
    render(
      <StreamingMessage parts={[{ type: "reasoning", text: "Working on it..." }]} />,
    );
    expect(screen.getByText("Working on it...")).toBeInTheDocument();
    expect(screen.getByText("Thought")).toBeInTheDocument();
  });

  it("hides typing indicator when reasoning is present", () => {
    const { container } = render(
      <StreamingMessage parts={[{ type: "reasoning", text: "Thinking..." }]} />,
    );
    expect(container.querySelector(".typing-indicator")).toBeNull();
  });

  it("renders tool-call during streaming in open thinking section", () => {
    render(
      <StreamingMessage
        parts={[
          { type: "tool-call", toolCallId: "tc1", toolName: "search", args: { q: "test" } },
        ]}
      />,
    );
    // Thinking section open by default during streaming, showing tool name
    expect(screen.getByText("search")).toBeInTheDocument();
    expect(screen.getByText("Running...")).toBeInTheDocument();
  });
});
