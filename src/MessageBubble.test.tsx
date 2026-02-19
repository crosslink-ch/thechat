import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MessageBubble, StreamingBubble } from "./MessageBubble";
import type { Message } from "./types";

const userMsg: Message = {
  id: "1",
  conversation_id: "c1",
  role: "user",
  content: "Hello world",
  reasoning_content: null,
  created_at: "2026-01-01T00:00:00Z",
};

const assistantMsg: Message = {
  id: "2",
  conversation_id: "c1",
  role: "assistant",
  content: "Hi there!",
  reasoning_content: "Let me think about this...",
  created_at: "2026-01-01T00:00:01Z",
};

const assistantMsgNoReasoning: Message = {
  id: "3",
  conversation_id: "c1",
  role: "assistant",
  content: "Quick reply",
  reasoning_content: null,
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
      screen.queryByText("Let me think about this...")
    ).not.toBeInTheDocument();
  });

  it("toggles reasoning content on click", () => {
    render(<MessageBubble message={assistantMsg} />);

    fireEvent.click(screen.getByText("Show Thinking"));
    expect(
      screen.getByText("Let me think about this...")
    ).toBeInTheDocument();
    expect(screen.getByText("Hide Thinking")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Hide Thinking"));
    expect(
      screen.queryByText("Let me think about this...")
    ).not.toBeInTheDocument();
  });
});

describe("StreamingBubble", () => {
  it("shows typing indicator when no content or reasoning", () => {
    const { container } = render(
      <StreamingBubble content="" reasoning="" />
    );
    expect(container.querySelector(".typing-indicator")).not.toBeNull();
  });

  it("shows content when available", () => {
    render(<StreamingBubble content="Responding..." reasoning="" />);
    expect(screen.getByText("Responding...")).toBeInTheDocument();
  });

  it("shows reasoning when available", () => {
    render(<StreamingBubble content="" reasoning="Thinking hard..." />);
    expect(screen.getByText("Thinking hard...")).toBeInTheDocument();
  });

  it("reasoning is open by default during streaming", () => {
    render(
      <StreamingBubble content="" reasoning="Working on it..." />
    );
    expect(screen.getByText("Working on it...")).toBeInTheDocument();
    expect(screen.getByText("Hide Thinking")).toBeInTheDocument();
  });

  it("hides typing indicator when reasoning is present", () => {
    const { container } = render(
      <StreamingBubble content="" reasoning="Thinking..." />
    );
    expect(container.querySelector(".typing-indicator")).toBeNull();
  });
});
