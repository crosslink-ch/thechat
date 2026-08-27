import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ConversationThreadPublic } from "@thechat/shared";
import { describe, expect, it, vi } from "vitest";
import { HermesRuntimePanel } from "./HermesRuntimePanel";

const thread: ConversationThreadPublic = {
  id: "thread-1",
  conversationId: "dm-1",
  botId: "bot-1",
  title: "First task",
  status: "open",
  createdById: "user-1",
  lastActivityAt: "2026-08-27T12:00:00.000Z",
  createdAt: "2026-08-27T12:00:00.000Z",
  updatedAt: "2026-08-27T12:00:00.000Z",
};

function renderPanel({
  onRenameThread = vi.fn().mockResolvedValue(undefined),
  onSelectThread = vi.fn(),
  activeThreadId = null,
}: {
  onRenameThread?: (threadId: string, title: string) => Promise<unknown>;
  onSelectThread?: (threadId: string | null) => void;
  activeThreadId?: string | null;
} = {}) {
  render(
    <HermesRuntimePanel
      botName="Hermes"
      runtime={{ invocations: [], events: [] }}
      loading={false}
      threads={[thread]}
      activeThreadId={activeThreadId}
      onRenameThread={onRenameThread}
      onSelectThread={onSelectThread}
    />,
  );
}

describe("HermesRuntimePanel task names", () => {
  it("keeps active styling on the selectable task control", () => {
    renderPanel({ activeThreadId: "thread-1" });

    expect(screen.getByRole("button", { name: /^First task/ })).toHaveClass(
      "bg-accent/10",
    );
  });

  it("renames a task inline without selecting it", async () => {
    const user = userEvent.setup();
    const onRenameThread = vi.fn().mockResolvedValue(undefined);
    const onSelectThread = vi.fn();
    renderPanel({ onRenameThread, onSelectThread });

    await user.click(screen.getByRole("button", { name: "Rename First task" }));

    const input = screen.getByRole("textbox", { name: "Task name" });
    expect(input).toHaveValue("First task");
    expect(input).toHaveFocus();
    expect(input).toHaveProperty("selectionStart", 0);
    expect(input).toHaveProperty("selectionEnd", "First task".length);

    await user.clear(input);
    await user.type(input, "  Plan launch  ");
    await user.keyboard("{Enter}");

    await waitFor(() =>
      expect(onRenameThread).toHaveBeenCalledWith("thread-1", "Plan launch"),
    );
    expect(onSelectThread).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.queryByRole("textbox", { name: "Task name" })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: "Rename First task" })).toHaveFocus();
  });

  it("keeps blank task names in the editor and cancels with Escape", async () => {
    const user = userEvent.setup();
    const onRenameThread = vi.fn().mockResolvedValue(undefined);
    renderPanel({ onRenameThread });

    await user.click(screen.getByRole("button", { name: "Rename First task" }));
    const input = screen.getByRole("textbox", { name: "Task name" });
    await user.clear(input);
    await user.keyboard("{Enter}");

    expect(screen.getByRole("alert")).toHaveTextContent("Enter a task name.");
    expect(onRenameThread).not.toHaveBeenCalled();

    await user.type(input, "Restored task");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("textbox", { name: "Task name" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Rename First task" })).toHaveFocus();
  });

  it("keeps the editor open when saving fails and allows a retry", async () => {
    const user = userEvent.setup();
    const onRenameThread = vi
      .fn()
      .mockRejectedValueOnce(new Error("API unavailable"))
      .mockResolvedValueOnce(undefined);
    renderPanel({ onRenameThread });

    await user.click(screen.getByRole("button", { name: "Rename First task" }));
    const input = screen.getByRole("textbox", { name: "Task name" });
    await user.clear(input);
    await user.type(input, "Retried task");
    await user.keyboard("{Enter}");

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not rename task. Try again.",
    );
    expect(input).toHaveValue("Retried task");
    expect(input).toHaveFocus();

    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onRenameThread).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.queryByRole("textbox", { name: "Task name" })).not.toBeInTheDocument(),
    );
  });
});
