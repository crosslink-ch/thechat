import { render } from "@testing-library/react";
import type { ChatMessage } from "@thechat/shared";
import { describe, expect, it } from "vitest";
import { SharedChatMessage } from "./SharedChatMessage";

const message: ChatMessage = {
  id: "mention-message",
  conversationId: "conversation-1",
  threadId: null,
  senderId: "other-user",
  senderName: "Alex",
  senderType: "human",
  content: "Dear @Bruno, thanks for the update.",
  createdAt: "2026-01-01T10:00:00.000Z",
};

describe("SharedChatMessage mention styling", () => {
  it.each([false, true])(
    "keeps regular row styling when mentioning you (merged=%s)",
    (merged) => {
      const { container, rerender } = render(
        <SharedChatMessage message={message} merged={merged}>
          <p>{message.content}</p>
        </SharedChatMessage>,
      );
      const row = container.querySelector("[data-message-id]");
      const regularClasses = row?.className;
      expect(row).not.toHaveAttribute("data-mentions-you");

      rerender(
        <SharedChatMessage message={message} merged={merged} mentionsYou>
          <p>{message.content}</p>
        </SharedChatMessage>,
      );

      expect(row).toHaveAttribute("data-mentions-you", "true");
      expect(row?.className).toBe(regularClasses);
      expect(row).toHaveClass("hover:bg-white/[0.025]");
      expect(row?.className).not.toMatch(/warning|shadow-/);
      expect(row).toHaveTextContent(message.content);
    },
  );
});
