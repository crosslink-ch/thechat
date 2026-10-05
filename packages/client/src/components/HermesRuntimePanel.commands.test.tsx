import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationThreadPublic } from "@thechat/shared";
import { CommandPalette, closePalette, openPaletteInCommandMode } from "../CommandPalette";
import { useCommandsStore } from "../commands";
import { HermesRuntimePanel } from "./HermesRuntimePanel";

const firstTask: ConversationThreadPublic = {
  id: "thread-1", conversationId: "dm-1", botId: "bot-1", title: "First task",
  status: "open", createdById: "user-1", lastActivityAt: "2026-08-27T12:00:00.000Z",
  createdAt: "2026-08-27T12:00:00.000Z", updatedAt: "2026-08-27T12:00:00.000Z",
};
const secondTask = { ...firstTask, id: "thread-2", title: "Second task" };

beforeEach(() => {
  closePalette();
  useCommandsStore.setState({ globalCommands: [], scopedCommands: {}, commands: [] });
});
afterEach(() => { cleanup(); closePalette(); vi.unstubAllGlobals(); });

function panel(onRenameThread = vi.fn().mockResolvedValue(undefined), activeThreadId: string | null = firstTask.id) {
  return <>
    <HermesRuntimePanel botName="Hermes" runtime={null} loading={false}
      threads={[firstTask, secondTask]} activeThreadId={activeThreadId} onRenameThread={onRenameThread} />
    <CommandPalette />
  </>;
}

describe("Hermes task Rename command", () => {
  it("renames the active task from the real command palette", async () => {
    const user = userEvent.setup();
    const onRenameThread = vi.fn().mockResolvedValue(undefined);
    render(panel(onRenameThread, secondTask.id));
    act(() => openPaletteInCommandMode());
    await user.type(screen.getByPlaceholderText("Type a command..."), "Rename");
    expect(screen.getByRole("button", { name: "Rename" })).toBeInTheDocument();
    await user.keyboard("{Enter}");

    expect(screen.queryByTestId("palette-panel")).not.toBeInTheDocument();
    const input = screen.getByRole("textbox", { name: "Task name" });
    expect(input).toHaveValue(secondTask.title);
    expect(input).toHaveFocus();
    expect(input).toHaveProperty("selectionStart", 0);
    expect(input).toHaveProperty("selectionEnd", secondTask.title.length);
    await user.keyboard("  Renamed active task  ");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(onRenameThread).toHaveBeenCalledWith(secondTask.id, "Renamed active task"));
  });

  it("opens the closed phone task drawer and focuses the active task editor", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    const user = userEvent.setup();
    render(panel());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    act(() => openPaletteInCommandMode());
    await user.click(screen.getByRole("button", { name: "Rename" }));
    expect(screen.getByRole("dialog", { name: "Tasks and activity" })).toBeInTheDocument();
    const input = screen.getByRole("textbox", { name: "Task name" });
    await waitFor(() => expect(input).toHaveFocus());
    expect(input).toHaveValue(firstTask.title);
    expect(input).toHaveProperty("selectionEnd", firstTask.title.length);
  });

  it.each([null, "missing-thread"])("does not offer Rename without a persisted active task (%s)", (activeThreadId) => {
    render(panel(undefined, activeThreadId));
    expect(useCommandsStore.getState().commands.find(command => command.id === "hermes.rename-task")).toBeUndefined();
  });

  it("does not offer Rename for a draft or a read-only task", () => {
    const view = (draftTaskActive: boolean, writable: boolean) =>
      <HermesRuntimePanel botName="Hermes" runtime={null} loading={false} threads={[firstTask]}
        activeThreadId={firstTask.id} draftTaskActive={draftTaskActive}
        onRenameThread={writable ? vi.fn() : undefined} />;
    const { rerender } = render(view(true, true));
    expect(useCommandsStore.getState().commands).toHaveLength(0);
    rerender(view(false, false));
    expect(useCommandsStore.getState().commands).toHaveLength(0);
  });

  it("targets the newly selected task and unregisters when leaving the panel", async () => {
    const user = userEvent.setup();
    const { rerender, unmount } = render(panel());
    rerender(panel(undefined, secondTask.id));
    act(() => openPaletteInCommandMode());
    await user.click(screen.getByRole("button", { name: "Rename" }));
    expect(screen.getByRole("textbox", { name: "Task name" })).toHaveValue(secondTask.title);
    unmount();
    expect(useCommandsStore.getState().commands).toHaveLength(0);
  });

  it("validates, cancels and retries using the existing inline editor", async () => {
    const user = userEvent.setup();
    const onRenameThread = vi.fn().mockRejectedValueOnce(new Error("Offline")).mockResolvedValue(undefined);
    render(panel(onRenameThread));
    act(() => openPaletteInCommandMode());
    await user.click(screen.getByRole("button", { name: "Rename" }));
    const input = screen.getByRole("textbox", { name: "Task name" });
    await user.clear(input);
    await user.keyboard("{Enter}");
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a task name.");
    expect(onRenameThread).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("textbox", { name: "Task name" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Rename First task" })).toHaveFocus();
    act(() => openPaletteInCommandMode());
    await user.click(screen.getByRole("button", { name: "Rename" }));
    await user.keyboard("Retried title{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not rename task. Try again.");
    expect(screen.getByRole("textbox", { name: "Task name" })).toHaveValue("Retried title");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onRenameThread).toHaveBeenCalledTimes(2));
  });

  it("selects the latest title after a task title update", async () => {
    const user = userEvent.setup();
    const onRenameThread = vi.fn();
    const view = (title: string) => <HermesRuntimePanel botName="Hermes" runtime={null} loading={false}
      threads={[{ ...firstTask, title }]} activeThreadId={firstTask.id} onRenameThread={onRenameThread} />;
    const { rerender } = render(<>{view(firstTask.title)}<CommandPalette /></>);
    rerender(<>{view("A longer updated task title")}<CommandPalette /></>);
    act(() => openPaletteInCommandMode());
    await user.click(screen.getByRole("button", { name: "Rename" }));
    const input = screen.getByRole("textbox", { name: "Task name" });
    expect(input).toHaveValue("A longer updated task title");
    expect(input).toHaveProperty("selectionStart", 0);
    expect(input).toHaveProperty("selectionEnd", "A longer updated task title".length);
  });
});
