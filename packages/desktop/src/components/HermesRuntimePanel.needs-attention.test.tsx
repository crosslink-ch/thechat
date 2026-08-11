import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ConversationThreadPublic } from "@thechat/shared";
import { HermesRuntimePanel } from "./HermesRuntimePanel";

const task: ConversationThreadPublic = {
  id: "task-1",
  conversationId: "dm-1",
  botId: "bot-1",
  title: "Review launch checklist",
  status: "active",
  createdById: "user-1",
  lastActivityAt: "2026-08-11T10:00:00.000Z",
  createdAt: "2026-08-11T09:00:00.000Z",
  updatedAt: "2026-08-11T10:00:00.000Z",
};

describe("HermesRuntimePanel needs-attention markers", () => {
  it("visually marks the specific selected Hermes task", () => {
    render(
      <HermesRuntimePanel
        botName="Koda"
        runtime={null}
        loading={false}
        threads={[task]}
        activeThreadId="task-1"
        needsAttentionThreadIds={new Set(["task-1"])}
        onSelectThread={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("button", {
        name: "Review launch checklist, needs attention",
      }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("task-needs-attention")).toHaveTextContent(
      "Attention",
    );
  });

  it("keeps the unread indicator alongside the attention badge", () => {
    render(
      <HermesRuntimePanel
        botName="Koda"
        runtime={null}
        loading={false}
        threads={[task]}
        needsAttentionThreadIds={new Set(["task-1"])}
        unreadThreadIds={new Set(["task-1"])}
      />,
    );

    expect(screen.getByTestId("task-needs-attention")).toBeInTheDocument();
    expect(screen.getByLabelText("Unread")).toBeInTheDocument();
  });

  it("can mark the general DM independently of its tasks", () => {
    render(
      <HermesRuntimePanel
        botName="Koda"
        runtime={null}
        loading={false}
        threads={[task]}
        generalNeedsAttention
      />,
    );

    expect(
      screen.getByRole("button", { name: "General, needs attention" }),
    ).toBeInTheDocument();
    expect(screen.getAllByTestId("task-needs-attention")).toHaveLength(1);
  });
});
