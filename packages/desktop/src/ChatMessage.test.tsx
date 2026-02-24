import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ChatMessage, StreamingMessage } from "./ChatMessage";
import { useStreamingStore } from "./stores/streaming";
import type { Message, MessagePart } from "./core/types";
import type { PermissionRequest } from "./core/permission";

const CONV_ID = "test-conv";

function setupStreaming(parts: MessagePart[]) {
  const store = useStreamingStore.getState();
  store.startStreaming(CONV_ID);
  if (parts.length > 0) {
    store.updateParts(CONV_ID, parts);
  }
}

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

beforeEach(() => {
  // Reset store between tests
  const store = useStreamingStore.getState();
  store.stopStreaming(CONV_ID);
});

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

  it("applies user data-testid for user messages", () => {
    render(<ChatMessage message={userMsg} />);
    expect(screen.getByTestId("chat-message-user")).toBeInTheDocument();
  });

  it("applies assistant data-testid for assistant messages", () => {
    render(<ChatMessage message={assistantMsg} />);
    expect(screen.getByTestId("chat-message-assistant")).toBeInTheDocument();
  });

  it("does not show thinking section for user messages", () => {
    render(<ChatMessage message={userMsg} />);
    expect(screen.queryByTestId("thinking-section")).toBeNull();
  });

  it("does not show thinking section for assistant without reasoning or tools", () => {
    render(<ChatMessage message={assistantMsgNoReasoning} />);
    expect(screen.queryByTestId("thinking-section")).toBeNull();
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
    setupStreaming([]);
    render(<StreamingMessage convId={CONV_ID} />);
    expect(screen.getByTestId("typing-indicator")).toBeInTheDocument();
  });

  it("returns null when not streaming", () => {
    const { container } = render(<StreamingMessage convId={CONV_ID} />);
    expect(container.querySelector("[data-testid='chat-message-assistant']")).toBeNull();
  });

  it("shows AI label", () => {
    setupStreaming([]);
    render(<StreamingMessage convId={CONV_ID} />);
    expect(screen.getByText("AI")).toBeInTheDocument();
  });

  it("shows content when available", () => {
    setupStreaming([{ type: "text", text: "Responding..." }]);
    render(<StreamingMessage convId={CONV_ID} />);
    expect(screen.getByText("Responding...")).toBeInTheDocument();
  });

  it("shows reasoning when available (thinking section open by default)", () => {
    setupStreaming([{ type: "reasoning", text: "Thinking hard..." }]);
    render(<StreamingMessage convId={CONV_ID} />);
    expect(screen.getByText("Thinking hard...")).toBeInTheDocument();
  });

  it("thinking section is open by default during streaming", () => {
    setupStreaming([{ type: "reasoning", text: "Working on it..." }]);
    render(<StreamingMessage convId={CONV_ID} />);
    expect(screen.getByText("Working on it...")).toBeInTheDocument();
    expect(screen.getByText("Thought")).toBeInTheDocument();
  });

  it("hides typing indicator when reasoning is present", () => {
    setupStreaming([{ type: "reasoning", text: "Thinking..." }]);
    render(<StreamingMessage convId={CONV_ID} />);
    expect(screen.queryByTestId("typing-indicator")).toBeNull();
  });

  it("renders tool-call during streaming in open thinking section", () => {
    setupStreaming([
      { type: "tool-call", toolCallId: "tc1", toolName: "search", args: { q: "test" } },
    ]);
    render(<StreamingMessage convId={CONV_ID} />);
    // Thinking section open by default during streaming, showing tool name
    expect(screen.getByText("search")).toBeInTheDocument();
    expect(screen.getByText("Running...")).toBeInTheDocument();
  });

  it("renders permission prompt when pendingPermission is provided", () => {
    const permission: PermissionRequest = {
      id: "1",
      convId: CONV_ID,
      command: "ls -la",
      description: "List files",
      resolve: vi.fn(),
      reject: vi.fn(),
    };
    setupStreaming([
      { type: "tool-call", toolCallId: "tc1", toolName: "shell", args: { command: "ls -la" } },
    ]);
    render(
      <StreamingMessage
        convId={CONV_ID}
        pendingPermission={permission}
        onPermissionAllow={vi.fn()}
        onPermissionDeny={vi.fn()}
      />,
    );
    expect(screen.getByText("Run command?")).toBeInTheDocument();
    expect(screen.getByText("ls -la")).toBeInTheDocument();
    expect(screen.getByText("List files")).toBeInTheDocument();
  });

  it("calls onPermissionAllow when Allow is clicked", () => {
    const onAllow = vi.fn();
    const permission: PermissionRequest = {
      id: "1",
      convId: CONV_ID,
      command: "echo hi",
      description: "",
      resolve: vi.fn(),
      reject: vi.fn(),
    };
    setupStreaming([]);
    render(
      <StreamingMessage
        convId={CONV_ID}
        pendingPermission={permission}
        onPermissionAllow={onAllow}
        onPermissionDeny={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText(/Allow/));
    expect(onAllow).toHaveBeenCalledOnce();
  });

  it("calls onPermissionDeny when Deny is clicked", () => {
    const onDeny = vi.fn();
    const permission: PermissionRequest = {
      id: "1",
      convId: CONV_ID,
      command: "rm -rf /",
      description: "",
      resolve: vi.fn(),
      reject: vi.fn(),
    };
    setupStreaming([]);
    render(
      <StreamingMessage
        convId={CONV_ID}
        pendingPermission={permission}
        onPermissionAllow={vi.fn()}
        onPermissionDeny={onDeny}
      />,
    );
    // Match the Deny button specifically (not "Deny with feedback")
    const denyBtn = screen.getAllByText(/Deny/).find(
      (el) => el.textContent?.trim().startsWith("Deny") && !el.textContent?.includes("feedback"),
    )!;
    fireEvent.click(denyBtn);
    expect(onDeny).toHaveBeenCalledOnce();
  });

  it("shows keyboard shortcut hints C-x a, C-x d, and C-x f", () => {
    const permission: PermissionRequest = {
      id: "1",
      convId: CONV_ID,
      command: "pwd",
      description: "",
      resolve: vi.fn(),
      reject: vi.fn(),
    };
    setupStreaming([]);
    render(
      <StreamingMessage
        convId={CONV_ID}
        pendingPermission={permission}
        onPermissionAllow={vi.fn()}
        onPermissionDeny={vi.fn()}
        onPermissionDenyWithFeedback={vi.fn()}
      />,
    );
    expect(screen.getByText("C-x a")).toBeInTheDocument();
    expect(screen.getByText("C-x d")).toBeInTheDocument();
    expect(screen.getByText("C-x f")).toBeInTheDocument();
  });

  it("renders 'Deny with feedback' button with C-x f hint", () => {
    const permission: PermissionRequest = {
      id: "1",
      convId: CONV_ID,
      command: "echo hi",
      description: "",
      resolve: vi.fn(),
      reject: vi.fn(),
    };
    setupStreaming([]);
    render(
      <StreamingMessage
        convId={CONV_ID}
        pendingPermission={permission}
        onPermissionAllow={vi.fn()}
        onPermissionDeny={vi.fn()}
        onPermissionDenyWithFeedback={vi.fn()}
      />,
    );
    expect(screen.getByText(/Deny with feedback/)).toBeInTheDocument();
    expect(screen.getByText("C-x f")).toBeInTheDocument();
  });

  it("clicking 'Deny with feedback' shows text input", () => {
    const permission: PermissionRequest = {
      id: "1",
      convId: CONV_ID,
      command: "echo hi",
      description: "",
      resolve: vi.fn(),
      reject: vi.fn(),
    };
    setupStreaming([]);
    render(
      <StreamingMessage
        convId={CONV_ID}
        pendingPermission={permission}
        onPermissionAllow={vi.fn()}
        onPermissionDeny={vi.fn()}
        onPermissionDenyWithFeedback={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText(/Deny with feedback/));
    expect(screen.getByPlaceholderText("Feedback for AI...")).toBeInTheDocument();
  });

  it("submitting feedback calls onPermissionDenyWithFeedback with the text", () => {
    const onDenyWithFeedback = vi.fn();
    const permission: PermissionRequest = {
      id: "1",
      convId: CONV_ID,
      command: "echo hi",
      description: "",
      resolve: vi.fn(),
      reject: vi.fn(),
    };
    setupStreaming([]);
    render(
      <StreamingMessage
        convId={CONV_ID}
        pendingPermission={permission}
        onPermissionAllow={vi.fn()}
        onPermissionDeny={vi.fn()}
        onPermissionDenyWithFeedback={onDenyWithFeedback}
      />,
    );
    fireEvent.click(screen.getByText(/Deny with feedback/));
    const input = screen.getByPlaceholderText("Feedback for AI...");
    fireEvent.change(input, { target: { value: "Use git diff instead" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onDenyWithFeedback).toHaveBeenCalledWith("Use git diff instead");
  });

  it("Escape hides the feedback input", () => {
    const permission: PermissionRequest = {
      id: "1",
      convId: CONV_ID,
      command: "echo hi",
      description: "",
      resolve: vi.fn(),
      reject: vi.fn(),
    };
    setupStreaming([]);
    render(
      <StreamingMessage
        convId={CONV_ID}
        pendingPermission={permission}
        onPermissionAllow={vi.fn()}
        onPermissionDeny={vi.fn()}
        onPermissionDenyWithFeedback={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText(/Deny with feedback/));
    const input = screen.getByPlaceholderText("Feedback for AI...");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByPlaceholderText("Feedback for AI...")).not.toBeInTheDocument();
  });

  it("empty feedback cannot be submitted (Send button disabled)", () => {
    const onDenyWithFeedback = vi.fn();
    const permission: PermissionRequest = {
      id: "1",
      convId: CONV_ID,
      command: "echo hi",
      description: "",
      resolve: vi.fn(),
      reject: vi.fn(),
    };
    setupStreaming([]);
    render(
      <StreamingMessage
        convId={CONV_ID}
        pendingPermission={permission}
        onPermissionAllow={vi.fn()}
        onPermissionDeny={vi.fn()}
        onPermissionDenyWithFeedback={onDenyWithFeedback}
      />,
    );
    fireEvent.click(screen.getByText(/Deny with feedback/));
    const sendBtn = screen.getByText("Send");
    expect(sendBtn).toBeDisabled();
    fireEvent.click(sendBtn);
    expect(onDenyWithFeedback).not.toHaveBeenCalled();
  });

  it("does not render permission prompt when pendingPermission is null", () => {
    setupStreaming([{ type: "text", text: "Hello" }]);
    render(
      <StreamingMessage convId={CONV_ID} pendingPermission={null} />,
    );
    expect(screen.queryByTestId("permission-inline")).toBeNull();
  });

  it("hides typing indicator when permission prompt is visible", () => {
    const permission: PermissionRequest = {
      id: "1",
      convId: CONV_ID,
      command: "echo test",
      description: "",
      resolve: vi.fn(),
      reject: vi.fn(),
    };
    setupStreaming([]);
    render(
      <StreamingMessage
        convId={CONV_ID}
        pendingPermission={permission}
        onPermissionAllow={vi.fn()}
        onPermissionDeny={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("typing-indicator")).toBeNull();
  });
});
