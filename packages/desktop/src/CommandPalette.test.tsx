import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { useCommandsStore, type Command } from "./commands";
import { CommandPalette, togglePalette, closePalette } from "./CommandPalette";

function makeCommand(overrides: Partial<Command> & { id: string; label: string }): Command {
  return {
    shortcut: null,
    keybinding: null,
    execute: vi.fn(),
    ...overrides,
  };
}

function makeTestCommands(): Command[] {
  return [
    makeCommand({ id: "toggle-sidebar", label: "Toggle Sidebar" }),
    makeCommand({ id: "workspace", label: "Workspace", shortcut: "Ctrl+L" }),
    makeCommand({ id: "settings", label: "Settings", shortcut: "C-x ," }),
  ];
}

async function renderPalette() {
  let result!: ReturnType<typeof render>;
  await act(async () => {
    result = render(<CommandPalette />);
  });
  act(() => togglePalette());
  return result;
}

function getInput() {
  return screen.getByPlaceholderText("Type a command...");
}

function type(text: string) {
  fireEvent.change(getInput(), { target: { value: text } });
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  closePalette();
  useCommandsStore.setState({
    globalCommands: [],
    scopedCommands: {},
    commands: [],
  });
});

describe("CommandPalette", () => {
  it("opens directly in command mode", async () => {
    useCommandsStore.getState().setCommands(makeTestCommands());
    await renderPalette();

    expect(getInput()).toBeInTheDocument();
    expect(screen.getByText("Toggle Sidebar")).toBeInTheDocument();
    expect(screen.getByText("Workspace")).toBeInTheDocument();
  });

  it("does not show hidden commands", async () => {
    useCommandsStore.getState().setCommands([
      ...makeTestCommands(),
      makeCommand({ id: "hidden-command", label: "Hidden Command", shortcut: "Ctrl+H", hidden: true }),
    ]);
    await renderPalette();

    expect(screen.queryByText("Hidden Command")).not.toBeInTheDocument();
    expect(screen.queryByText("Ctrl+H")).not.toBeInTheDocument();
  });

  it("filters commands by label", async () => {
    useCommandsStore.getState().setCommands(makeTestCommands());
    await renderPalette();

    type("settings");

    expect(screen.getByText("Settings")).toBeInTheDocument();
    expect(screen.queryByText("Toggle Sidebar")).not.toBeInTheDocument();
  });

  it("also accepts a leading > for existing command-palette muscle memory", async () => {
    useCommandsStore.getState().setCommands(makeTestCommands());
    await renderPalette();

    type(">settings");

    expect(screen.getByText("Settings")).toBeInTheDocument();
    expect(screen.queryByText("Toggle Sidebar")).not.toBeInTheDocument();
  });

  it("shows shortcut badges for commands that have them", async () => {
    useCommandsStore.getState().setCommands(makeTestCommands());
    const { container } = await renderPalette();

    const kbds = container.querySelectorAll("kbd");
    const kbdTexts = Array.from(kbds).map((el) => el.textContent);
    expect(kbdTexts).toContain("Ctrl+L");
    expect(kbdTexts).toContain("C-x ,");
  });

  it("does not render a <kbd> for commands without a shortcut", async () => {
    const noShortcutCmd = makeCommand({ id: "toggle-sidebar", label: "Toggle Sidebar" });
    useCommandsStore.getState().setCommands([noShortcutCmd]);
    await renderPalette();

    const item = screen.getByText("Toggle Sidebar").closest("[data-testid='palette-item']");
    expect(item?.querySelector("kbd")).toBeNull();
  });

  it("shows empty state when no commands match", async () => {
    useCommandsStore.getState().setCommands(makeTestCommands());
    await renderPalette();

    type("zzzzz");

    expect(screen.getByText("No matching commands")).toBeInTheDocument();
  });

  it("executes the highlighted command on Enter", async () => {
    const cmds = makeTestCommands();
    useCommandsStore.getState().setCommands(cmds);
    await renderPalette();

    fireEvent.keyDown(getInput(), { key: "Enter" });

    expect(cmds[0].execute).toHaveBeenCalledOnce();
  });

  it("arrow keys navigate the command list", async () => {
    const cmds = makeTestCommands();
    useCommandsStore.getState().setCommands(cmds);
    await renderPalette();

    fireEvent.keyDown(getInput(), { key: "ArrowDown" });
    fireEvent.keyDown(getInput(), { key: "Enter" });

    expect(cmds[0].execute).not.toHaveBeenCalled();
    expect(cmds[1].execute).toHaveBeenCalledOnce();
  });

  it("clicking a command executes it", async () => {
    const cmds = makeTestCommands();
    useCommandsStore.getState().setCommands(cmds);
    await renderPalette();

    fireEvent.click(screen.getByText("Toggle Sidebar"));

    const toggleCmd = cmds.find((c) => c.id === "toggle-sidebar")!;
    expect(toggleCmd.execute).toHaveBeenCalledOnce();
  });

  it("Escape closes the palette", async () => {
    await renderPalette();

    expect(getInput()).toBeInTheDocument();
    fireEvent.keyDown(getInput(), { key: "Escape" });

    expect(screen.queryByPlaceholderText("Type a command...")).not.toBeInTheDocument();
  });

  it("clicking overlay closes the palette", async () => {
    await renderPalette();

    const overlay = screen.getByTestId("palette-panel").parentElement!;
    fireEvent.click(overlay);

    expect(screen.queryByPlaceholderText("Type a command...")).not.toBeInTheDocument();
  });
});
