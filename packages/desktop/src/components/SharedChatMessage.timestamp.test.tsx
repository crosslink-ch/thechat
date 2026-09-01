import { cleanup, render, screen } from "@testing-library/react";
import type { ChatMessage } from "@thechat/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SharedChatMessage } from "./SharedChatMessage";

const message: ChatMessage = {
  id: "timestamp-message",
  conversationId: "channel-1",
  senderId: "sender-1",
  senderName: "Koda",
  senderType: "bot",
  content: "Timestamp message",
  createdAt: "2026-07-14T08:00:00.000Z",
  threadId: null,
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("SharedChatMessage timestamps", () => {
  it("keeps grouped historical times compact with a full accessible date", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 15, 12));
    const sent = new Date(2026, 6, 14, 8);
    const fullTime = sent.toLocaleString([], {
      dateStyle: "medium",
      timeStyle: "short",
    });
    render(
      <SharedChatMessage
        message={{ ...message, createdAt: sent.toISOString() }}
        merged={true}
      >
        Timestamp message
      </SharedChatMessage>,
    );
    const timestamp = screen.getByLabelText(`Sent ${fullTime}`);
    expect(timestamp).toHaveTextContent(sent.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    }));
    expect(timestamp).not.toHaveTextContent("Yesterday");
    expect(timestamp).toHaveAttribute("datetime", sent.toISOString());
    expect(timestamp).toHaveAttribute("title", fullTime);
    expect(timestamp).toHaveAttribute("tabindex", "0");
    expect(timestamp).toHaveClass("w-8", "opacity-0", "active:opacity-100");
  });

  it.each([false, true])("safely renders invalid timestamps when merged=%s", (merged) => {
    const { container } = render(
      <SharedChatMessage
        message={{ ...message, createdAt: "not-a-date" }}
        merged={merged}
      >
        Timestamp message
      </SharedChatMessage>,
    );
    const timestamp = container.querySelector("time");
    expect(timestamp).toHaveTextContent("Unknown time");
    expect(timestamp).toHaveAttribute("title", "Unknown time");
    expect(timestamp).not.toHaveAttribute("datetime");
    if (merged) expect(timestamp).toHaveAttribute("aria-label", "Sent Unknown time");
  });
});
