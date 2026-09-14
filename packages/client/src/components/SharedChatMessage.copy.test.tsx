import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ChatMessage } from "@thechat/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SharedChatMessage } from "./SharedChatMessage";

const message: ChatMessage = {
  id: "copy-message",
  conversationId: "channel-1",
  senderId: "sender-1",
  senderName: "Alice",
  senderType: "human",
  content: "  **Hello** 👋\n\n```ts\nconst answer = 42;\n```\n",
  createdAt: "2026-09-14T08:00:00.000Z",
  threadId: null,
};

const originalClipboard = Object.getOwnPropertyDescriptor(
  navigator,
  "clipboard",
);
afterEach(() => {
  if (originalClipboard)
    Object.defineProperty(navigator, "clipboard", originalClipboard);
  else Reflect.deleteProperty(navigator, "clipboard");
});

describe("Copy message", () => {
  it.each([false, true])(
    "copies without reaction permissions when merged=%s",
    async (merged) => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText },
      });
      render(
        <SharedChatMessage
          message={{ ...message, senderType: "bot" }}
          merged={merged}
        >
          Answer
        </SharedChatMessage>,
      );
      expect(
        screen.queryByRole("button", { name: "Add reaction" }),
      ).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Copy message" }));
      await waitFor(() =>
        expect(writeText).toHaveBeenCalledExactlyOnceWith(message.content),
      );
    },
  );

  it("does not offer to copy an attachment-only message", () => {
    render(
      <SharedChatMessage
        message={{ ...message, content: "" }}
        merged={false}
        onSetReaction={vi.fn()}
      >
        Attachment
      </SharedChatMessage>,
    );
    expect(
      screen.queryByRole("button", { name: "Copy message" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Add reaction" }),
    ).toBeInTheDocument();
  });

  it.each(["denied", "unavailable"])(
    "reports %s clipboard access and allows retry",
    async (failure) => {
      const writeText = vi
        .fn()
        .mockRejectedValue(new Error("Permission denied"));
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: failure === "denied" ? { writeText } : undefined,
      });
      render(
        <SharedChatMessage
          message={message}
          merged={false}
          onSetReaction={vi.fn()}
        >
          Message
        </SharedChatMessage>,
      );
      fireEvent.click(screen.getByRole("button", { name: "Copy message" }));
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Could not copy message. Try again.",
      );
      expect(
        screen.getByRole("button", { name: "Copy message" }),
      ).not.toHaveAttribute("title", "Copied!");
      writeText.mockResolvedValue(undefined);
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText },
      });
      fireEvent.click(screen.getByRole("button", { name: "Copy message" }));
      await waitFor(() =>
        expect(screen.getByRole("status")).toHaveTextContent("Message copied"),
      );
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    },
  );
  it("copies the exact message source next to reactions, not rendered metadata", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const onSetReaction = vi.fn();
    render(
      <SharedChatMessage
        message={message}
        merged={false}
        onSetReaction={onSetReaction}
      >
        <p>Rendered message without Markdown syntax</p>
      </SharedChatMessage>,
    );

    const copy = screen.getByRole("button", { name: "Copy message" });
    expect(copy.parentElement).toBe(
      screen.getByRole("button", { name: "Add reaction" }).parentElement,
    );
    fireEvent.click(copy);
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledExactlyOnceWith(message.content),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Message copied",
    );
    expect(onSetReaction).not.toHaveBeenCalled();
  });
});
