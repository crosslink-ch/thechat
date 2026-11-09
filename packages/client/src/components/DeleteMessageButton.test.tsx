import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { ChatMessage } from "@thechat/shared";
import { SharedChatMessage } from "./SharedChatMessage";
import { useAuthStore } from "../stores/auth";
import { wsEvents } from "../lib/ws-events";

const { deleteMock } = vi.hoisted(() => ({ deleteMock: vi.fn() }));
vi.mock("../lib/api", () => ({ api: { messages: () => () => ({ delete: deleteMock }) } }));
vi.mock("../lib/bot-appearance", () => ({ useBotAppearance: () => undefined }));
const message: ChatMessage = {
  id: "message-1", conversationId: "conversation-1", threadId: null,
  senderId: "author", senderName: "Alice", senderType: "human", content: "Accidental message", parts: null, createdAt: "2026-01-01T00:00:00Z",
};
beforeEach(() => {
  deleteMock.mockReset();
  useAuthStore.setState({ user: { id: "author", name: "Alice", email: "alice@example.invalid", avatar: null, type: "human" }, token: "test-token" });
});
function show(msg = message) { return render(<SharedChatMessage message={msg} merged={false}>{msg.content}</SharedChatMessage>); }

it("hides delete on someone else's message and on a pending optimistic send", () => {
  const view = show({ ...message, senderId: "someone-else" });
  expect(screen.queryByRole("button", { name: "Delete message" })).not.toBeInTheDocument();
  view.rerender(<SharedChatMessage message={{ ...message, id: "optimistic:send" }} merged={false}>Pending</SharedChatMessage>);
  expect(screen.queryByRole("button", { name: "Delete message" })).not.toBeInTheDocument();
});

it("cancel is the safe default and never calls the API", async () => {
  show();
  fireEvent.click(screen.getByRole("button", { name: "Delete message" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus());
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(deleteMock).not.toHaveBeenCalled();
});

it("keeps errors visible, allows retry and reconciles only a successful deletion", async () => {
  deleteMock.mockResolvedValueOnce({ error: { status: 409, value: { error: "Wait for the bot" } } });
  const deleted = vi.fn();
  wsEvents.on("ws:message_deleted", deleted);
  try {
    show();
    fireEvent.click(screen.getByRole("button", { name: "Delete message" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete for everyone" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Wait for the bot"));
    expect(deleted).not.toHaveBeenCalled();
    deleteMock.mockResolvedValueOnce({ data: { ok: true, conversationId: message.conversationId, messageId: message.id, threadId: null } });
    fireEvent.click(screen.getByRole("button", { name: "Delete for everyone" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(deleteMock).toHaveBeenLastCalledWith(undefined, { headers: { authorization: "Bearer test-token" } });
    expect(deleted).toHaveBeenCalledWith(expect.objectContaining({ messageId: message.id }));
  } finally { wsEvents.off("ws:message_deleted", deleted); }
});
