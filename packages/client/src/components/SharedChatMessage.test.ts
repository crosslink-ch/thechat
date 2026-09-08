import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@thechat/shared";
import { shouldMergeChatMessage } from "./SharedChatMessage";

describe("shouldMergeChatMessage", () => {
  it("starts a new group when the thread context changes", () => {
    const previous = message({
      id: "message-1",
      threadId: null,
      createdAt: "2026-01-01T10:00:00.000Z",
    });
    const current = message({
      id: "message-2",
      threadId: "thread-1",
      createdAt: "2026-01-01T10:01:00.000Z",
    });

    expect(shouldMergeChatMessage(previous, current)).toBe(false);
  });

  it("starts a new group when the conversation changes", () => {
    const previous = message({
      id: "message-1",
      conversationId: "conversation-1",
      createdAt: "2026-01-01T10:00:00.000Z",
    });
    const current = message({
      id: "message-2",
      conversationId: "conversation-2",
      createdAt: "2026-01-01T10:01:00.000Z",
    });

    expect(shouldMergeChatMessage(previous, current)).toBe(false);
  });

  it("merges messages at the five-minute boundary", () => {
    const previous = message({ createdAt: "2026-01-01T10:00:00.000Z" });
    const current = message({
      id: "message-2",
      createdAt: "2026-01-01T10:05:00.000Z",
    });

    expect(shouldMergeChatMessage(previous, current)).toBe(true);
  });

  it("starts a new group after the five-minute boundary", () => {
    const previous = message({ createdAt: "2026-01-01T10:00:00.000Z" });
    const current = message({
      id: "message-2",
      createdAt: "2026-01-01T10:05:00.001Z",
    });

    expect(shouldMergeChatMessage(previous, current)).toBe(false);
  });

  it("starts a new group when the sender changes", () => {
    const previous = message({ senderId: "user-1" });
    const current = message({
      id: "message-2",
      senderId: "user-2",
      senderName: "Ada",
      createdAt: "2026-01-01T10:01:00.000Z",
    });

    expect(shouldMergeChatMessage(previous, current)).toBe(false);
  });

  it("starts a new group when there is no adjacent message", () => {
    expect(shouldMergeChatMessage(undefined, message())).toBe(false);
  });

  it("starts a new group for invalid or reverse-ordered timestamps", () => {
    expect(
      shouldMergeChatMessage(
        message({ createdAt: "not-a-date" }),
        message({ id: "message-2" }),
      ),
    ).toBe(false);
    expect(
      shouldMergeChatMessage(
        message({ createdAt: "2026-01-01T10:01:00.000Z" }),
        message({
          id: "message-2",
          createdAt: "2026-01-01T10:00:00.000Z",
        }),
      ),
    ).toBe(false);
  });

  it("starts a new group at a local date boundary", () => {
    const previous = message({
      id: "message-1",
      createdAt: new Date(2026, 0, 1, 23, 59).toISOString(),
    });
    const current = message({
      id: "message-2",
      createdAt: new Date(2026, 0, 2, 0, 0).toISOString(),
    });

    expect(shouldMergeChatMessage(previous, current)).toBe(false);
  });
});

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "message-1",
    conversationId: "conversation-1",
    threadId: null,
    senderId: "user-1",
    senderName: "Koda",
    senderType: "bot",
    content: "Message content",
    createdAt: "2026-01-01T10:00:00.000Z",
    ...overrides,
  };
}
