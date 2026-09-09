import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import type { ChatMessage } from "@thechat/shared";
import { useActivityStore } from "../stores/activity";
import { usePersistConversationRead } from "./usePersistConversationRead";

const messages: ChatMessage[] = [
  {
    id: "message-1",
    conversationId: "conversation-1",
    threadId: null,
    senderId: "user-2",
    senderName: "Alice",
    senderType: "human",
    content: "First",
    createdAt: "2026-09-01T10:00:00.000Z",
  },
  {
    id: "message-2",
    conversationId: "conversation-1",
    threadId: null,
    senderId: "user-2",
    senderName: "Alice",
    senderType: "human",
    content: "Second",
    createdAt: "2026-09-01T10:01:00.000Z",
  },
];

beforeEach(() => {
  useActivityStore.getState().reset();
  useActivityStore.setState({
    markConversationRead: vi.fn().mockResolvedValue(undefined),
  });
});

describe("usePersistConversationRead", () => {
  it("marks every rendered server message ID", async () => {
    const { rerender } = renderHook(
      ({ renderedMessages }) =>
        usePersistConversationRead(
          "conversation-1",
          renderedMessages,
          true,
        ),
      { initialProps: { renderedMessages: [] as ChatMessage[] } },
    );

    expect(
      useActivityStore.getState().markConversationRead,
    ).not.toHaveBeenCalled();

    rerender({ renderedMessages: messages });

    await waitFor(() => {
      expect(
        useActivityStore.getState().markConversationRead,
      ).toHaveBeenCalledWith("conversation-1", ["message-1", "message-2"]);
    });
  });

  it("does not mark disabled or empty views read", () => {
    renderHook(() =>
      usePersistConversationRead("conversation-1", messages, false),
    );
    renderHook(() => usePersistConversationRead("conversation-1", [], true));

    expect(
      useActivityStore.getState().markConversationRead,
    ).not.toHaveBeenCalled();
  });

  it("never sends optimistic local IDs to the read API", async () => {
    const optimistic: ChatMessage = {
      ...messages[1],
      id: "optimistic:client-message-1",
    };
    renderHook(() =>
      usePersistConversationRead(
        "conversation-1",
        [...messages, optimistic],
        true,
      ),
    );

    await waitFor(() => {
      expect(
        useActivityStore.getState().markConversationRead,
      ).toHaveBeenCalledWith("conversation-1", ["message-1", "message-2"]);
    });
  });
});
