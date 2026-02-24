import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import {
  RouterProvider,
  createMemoryHistory,
  createRouter,
  createRootRoute,
  createRoute,
} from "@tanstack/react-router";
import { useConversationsStore } from "./stores/conversations";
import { useCommandsStore, type Command } from "./commands";
import { CommandPalette, togglePalette, closePalette } from "./CommandPalette";
import type { Conversation } from "./core/types";

// --- Helpers ---

const conversations: Conversation[] = [
  { id: "c1", title: "Debug session", project_dir: null, created_at: "2026-01-01", updated_at: "2026-01-01" },
  { id: "c2", title: "Refactor chat loop", project_dir: null, created_at: "2026-01-02", updated_at: "2026-01-02" },
];

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
    makeCommand({ id: "new-chat", label: "New Chat", shortcut: "C-x n" }),
    makeCommand({ id: "toggle-sidebar", label: "Toggle Sidebar" }),
    makeCommand({ id: "login", label: "Log In", shortcut: "Ctrl+L" }),
  ];
}

async function renderPalette() {
  const rootRoute = createRootRoute({
    component: () => <CommandPalette />,
  });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => null,
  });
  const routeTree = rootRoute.addChildren([indexRoute]);
  const memoryHistory = createMemoryHistory({ initialEntries: ["/"] });
  const router = createRouter({ routeTree, history: memoryHistory });

  let result!: ReturnType<typeof render>;
  await act(async () => {
    result = render(<RouterProvider router={router as any} />);
  });
  // Open the palette
  act(() => togglePalette());
  return result;
}

function getInput() {
  return screen.getByPlaceholderText(/search chats|type a command/i);
}

function type(text: string) {
  fireEvent.change(getInput(), { target: { value: text } });
}

// --- Setup ---

beforeEach(() => {
  // jsdom doesn't implement scrollIntoView
  Element.prototype.scrollIntoView = vi.fn();

  closePalette();
  useConversationsStore.setState({
    conversations: [],
    unreadAgentChats: new Set(),
    unreadChannels: new Set(),
  });
  useCommandsStore.setState({ commands: [] });
});

// --- Tests ---

describe("CommandPalette", () => {
  describe("default (conversation) mode", () => {
    it("shows conversations in default mode", async () => {
      useConversationsStore.setState({ conversations });
      await renderPalette();

      expect(screen.getByText("Debug session")).toBeInTheDocument();
      expect(screen.getByText("Refactor chat loop")).toBeInTheDocument();
    });

    it("does not show command labels in default mode", async () => {
      useConversationsStore.setState({ conversations });
      useCommandsStore.setState({ commands: makeTestCommands() });
      await renderPalette();

      expect(screen.queryByText("New Chat")).not.toBeInTheDocument();
      expect(screen.queryByText("Toggle Sidebar")).not.toBeInTheDocument();
    });

    it("filters conversations by query", async () => {
      useConversationsStore.setState({ conversations });
      await renderPalette();

      type("debug");

      expect(screen.getByText("Debug session")).toBeInTheDocument();
      expect(screen.queryByText("Refactor chat loop")).not.toBeInTheDocument();
    });

    it("shows empty state when no conversations match", async () => {
      useConversationsStore.setState({ conversations });
      await renderPalette();

      type("zzzzz");

      expect(screen.getByText("No matching chats")).toBeInTheDocument();
    });

    it("shows the default placeholder", async () => {
      await renderPalette();
      expect(screen.getByPlaceholderText("Search chats (type > for commands)")).toBeInTheDocument();
    });
  });

  describe("command mode (> prefix)", () => {
    it("switches to command mode when > is typed", async () => {
      useConversationsStore.setState({ conversations });
      useCommandsStore.setState({ commands: makeTestCommands() });
      await renderPalette();

      type(">");

      // Commands visible
      expect(screen.getByText("New Chat")).toBeInTheDocument();
      expect(screen.getByText("Toggle Sidebar")).toBeInTheDocument();
      // Conversations hidden
      expect(screen.queryByText("Debug session")).not.toBeInTheDocument();
    });

    it("changes placeholder in command mode", async () => {
      await renderPalette();
      type(">");
      expect(screen.getByPlaceholderText("Type a command...")).toBeInTheDocument();
    });

    it("filters commands by label", async () => {
      useCommandsStore.setState({ commands: makeTestCommands() });
      await renderPalette();

      type(">new");

      expect(screen.getByText("New Chat")).toBeInTheDocument();
      expect(screen.queryByText("Toggle Sidebar")).not.toBeInTheDocument();
    });

    it("shows shortcut badges for commands that have them", async () => {
      useCommandsStore.setState({ commands: makeTestCommands() });
      const { container } = await renderPalette();
      type(">");

      const kbds = container.querySelectorAll("kbd");
      const kbdTexts = Array.from(kbds).map((el) => el.textContent);
      expect(kbdTexts).toContain("C-x n");
      expect(kbdTexts).toContain("Ctrl+L");
    });

    it("does not render a <kbd> for commands without a shortcut", async () => {
      const noShortcutCmd = makeCommand({ id: "toggle-sidebar", label: "Toggle Sidebar" });
      useCommandsStore.setState({ commands: [noShortcutCmd] });
      await renderPalette();
      type(">");

      const item = screen.getByText("Toggle Sidebar").closest(".palette-item");
      expect(item?.querySelector("kbd")).toBeNull();
    });

    it("shows empty state when no commands match", async () => {
      useCommandsStore.setState({ commands: makeTestCommands() });
      await renderPalette();

      type(">zzzzz");

      expect(screen.getByText("No matching commands")).toBeInTheDocument();
    });

    it("executes the highlighted command on Enter", async () => {
      const cmds = makeTestCommands();
      useCommandsStore.setState({ commands: cmds });
      await renderPalette();
      type(">");

      fireEvent.keyDown(getInput(), { key: "Enter" });

      expect(cmds[0].execute).toHaveBeenCalledOnce();
    });

    it("arrow keys navigate the command list", async () => {
      const cmds = makeTestCommands();
      useCommandsStore.setState({ commands: cmds });
      await renderPalette();
      type(">");

      fireEvent.keyDown(getInput(), { key: "ArrowDown" });
      fireEvent.keyDown(getInput(), { key: "Enter" });

      expect(cmds[0].execute).not.toHaveBeenCalled();
      expect(cmds[1].execute).toHaveBeenCalledOnce();
    });

    it("clicking a command executes it", async () => {
      const cmds = makeTestCommands();
      useCommandsStore.setState({ commands: cmds });
      await renderPalette();
      type(">");

      fireEvent.click(screen.getByText("Toggle Sidebar"));

      const toggleCmd = cmds.find((c) => c.id === "toggle-sidebar")!;
      expect(toggleCmd.execute).toHaveBeenCalledOnce();
    });
  });

  describe("mode switching", () => {
    it("returns to conversation mode when > is cleared", async () => {
      useConversationsStore.setState({ conversations });
      useCommandsStore.setState({ commands: makeTestCommands() });
      await renderPalette();

      type(">");
      expect(screen.getByText("New Chat")).toBeInTheDocument();

      type("");
      expect(screen.getByText("Debug session")).toBeInTheDocument();
      expect(screen.queryByText("New Chat")).not.toBeInTheDocument();
    });
  });

  describe("shared behavior", () => {
    it("Escape closes the palette", async () => {
      await renderPalette();

      expect(getInput()).toBeInTheDocument();
      fireEvent.keyDown(getInput(), { key: "Escape" });

      expect(screen.queryByPlaceholderText(/search chats/i)).not.toBeInTheDocument();
    });

    it("clicking overlay closes the palette", async () => {
      await renderPalette();

      const overlay = screen.getByPlaceholderText(/search chats/i).closest(".palette-panel")!.parentElement!;
      fireEvent.click(overlay);

      expect(screen.queryByPlaceholderText(/search chats/i)).not.toBeInTheDocument();
    });
  });
});
