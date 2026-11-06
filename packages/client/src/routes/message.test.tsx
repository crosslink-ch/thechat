import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ChatMessage, MessageContext } from "@thechat/shared";

const navigation = vi.hoisted(() => ({ openSearchLocation: vi.fn() }));
vi.mock("../lib/search-navigation", () => ({ ...navigation, JumpSupersededError: class extends Error {} }));
vi.mock("../components/Markdown", () => ({ Markdown: ({ content }: { content: string }) => <p>{content}</p> }));

import { MessageContextView } from "./message";

function message(id: string, content: string, minute: number, senderName = "Simon"): ChatMessage {
  return {
    id, conversationId: "dm-koda", threadId: "t-1", senderId: `u-${senderName}`, senderName,
    senderType: "human", content, parts: null, attachments: [], reactions: [],
    createdAt: new Date(Date.UTC(2026, 9, 1, 9, minute)).toISOString(),
  };
}

const context: MessageContext = {
  conversation: { id: "dm-koda", type: "direct", name: "Koda", workspaceId: "w1", workspaceName: "Cross-Link" },
  threadId: "t-1",
  threadTitle: "Invoice cleanup",
  targetMessageId: "m2",
  messages: [message("m1", "first", 0), message("m2", "the one we searched for", 1), message("m3", "after", 2, "Koda")],
  hasOlder: true,
  hasNewer: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  navigation.openSearchLocation.mockResolvedValue(undefined);
});

describe("MessageContextView", () => {
  it("shows the target highlighted between its neighbours, with where it lives", () => {
    const scrollIntoView = vi.spyOn(Element.prototype, "scrollIntoView");
    render(<MessageContextView context={context} />);
    const header = within(screen.getByTestId("message-context-header"));
    expect(header.getByText("Koda")).toBeInTheDocument();
    expect(header.getByText("Invoice cleanup")).toBeInTheDocument();
    expect(header.getByText("· Cross-Link")).toBeInTheDocument();
    const rows = Array.from(document.querySelectorAll("[data-message-id]")).map((row) => row.getAttribute("data-message-id"));
    expect(rows).toEqual(["m1", "m2", "m3"]);
    const target = document.querySelector("[data-search-target='true'] [data-message-id]");
    expect(target).toHaveAttribute("data-message-id", "m2");
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "center" });
    expect(screen.getByText("Earlier messages are in the conversation")).toBeInTheDocument();
    expect(screen.queryByText("Later messages are in the conversation")).not.toBeInTheDocument();
  });

  it("opens the task the message belongs to", async () => {
    render(<MessageContextView context={context} />);
    fireEvent.click(screen.getByRole("button", { name: "Open task" }));
    await waitFor(() =>
      expect(navigation.openSearchLocation).toHaveBeenCalledWith({
        workspaceId: "w1",
        conversationId: "dm-koda",
        conversationType: "direct",
        threadId: "t-1",
      }),
    );
  });

  it("reports a failed open", async () => {
    navigation.openSearchLocation.mockRejectedValue(new Error("Could not open that workspace"));
    render(<MessageContextView context={{ ...context, threadId: null, threadTitle: null }} />);
    fireEvent.click(screen.getByRole("button", { name: "Open conversation" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not open that workspace");
  });
});
