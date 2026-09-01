import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, renderHook } from "@testing-library/react";

const closePaletteMock = vi.fn();
const closePaletteAndRefocusMock = vi.fn();
const togglePaletteMock = vi.fn();
const openPaletteInCommandModeMock = vi.fn();
const toggleSidebarMock = vi.fn();
const openWorkspaceModalMock = vi.fn();
const openHermesBotModalMock = vi.fn();

vi.mock("./CommandPalette", () => ({
  togglePalette: () => togglePaletteMock(),
  closePalette: () => closePaletteMock(),
  closePaletteAndRefocus: () => closePaletteAndRefocusMock(),
  openPaletteInCommandMode: () => openPaletteInCommandModeMock(),
}));

vi.mock("./components/Sidebar", () => ({
  toggleSidebar: () => toggleSidebarMock(),
}));

vi.mock("./components/WorkspaceModal", () => ({
  openWorkspaceModal: () => openWorkspaceModalMock(),
}));

vi.mock("./components/HermesBotModal", () => ({
  openHermesBotModal: () => openHermesBotModalMock(),
}));

import { createCommands, useCommandsStore } from "./commands";
import { useKeybindings } from "./hooks/useKeybindings";
import { useWorkspacesStore } from "./stores/workspaces";

describe("createCommands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("opens the command palette from macOS Command+K", () => {
    useCommandsStore.getState().setCommands(createCommands(vi.fn()));
    const { unmount } = renderHook(() =>
      useKeybindings({
        onPermissionAllow: null,
        onPermissionDeny: null,
        onPermissionDenyWithFeedback: null,
        handleRegistryCommands: true,
      }),
    );

    fireEvent.keyDown(window, { key: "k", metaKey: true });
    unmount();

    expect(togglePaletteMock).toHaveBeenCalledOnce();
  });

  it("exposes restored ACP Agent Chat access without legacy model commands", () => {
    const navigate = vi.fn();
    const commands = createCommands(navigate);
    const agentChat = commands.find((command) => command.id === "new-agent-chat");

    expect(agentChat).toMatchObject({
      label: "New Agent Chat",
      shortcut: "C-x n",
    });
    agentChat!.execute();
    expect(navigate).toHaveBeenCalledWith({ to: "/chat" });
    expect(closePaletteAndRefocusMock).toHaveBeenCalledOnce();

    const ids = commands.map((command) => command.id);
    expect(ids).not.toContain("configure-mcp");
    expect(ids).not.toContain("switch-permission-mode");
    expect(ids).not.toContain("select-model");
  });

  it("opens user-scoped bot management without an active workspace", () => {
    const navigate = vi.fn();
    const command = createCommands(navigate).find((c) => c.id === "manage-bots");

    expect(useWorkspacesStore.getState().activeWorkspace).toBeNull();
    expect(command).toMatchObject({ id: "manage-bots", label: "Manage Bots" });

    command!.execute();

    expect(navigate).toHaveBeenCalledWith({ to: "/bots/manage" });
    expect(closePaletteAndRefocusMock).toHaveBeenCalledOnce();
  });

  it("navigates to workspace access management", () => {
    const navigate = vi.fn();
    const command = createCommands(navigate).find((c) => c.id === "manage-workspace");

    expect(command).toMatchObject({
      id: "manage-workspace",
      label: "Manage Workspace",
    });

    command!.execute();
    expect(navigate).toHaveBeenCalledWith({ to: "/workspace/manage" });
    expect(closePaletteAndRefocusMock).toHaveBeenCalledOnce();
  });

  it("opens the Add Hermes Bot flow from a dedicated command", () => {
    const navigate = vi.fn();
    const command = createCommands(navigate).find((c) => c.id === "add-hermes-bot");

    expect(command).toMatchObject({
      id: "add-hermes-bot",
      label: "Add Hermes Bot",
    });

    command!.execute();

    expect(closePaletteMock).toHaveBeenCalledOnce();
    expect(openHermesBotModalMock).toHaveBeenCalledOnce();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("registers debug routes as dev-only commands", () => {
    const navigate = vi.fn();
    const commands = createCommands(navigate);
    const scrollDebug = commands.find((c) => c.id === "debug-scroll");
    const hermesDebug = commands.find((c) => c.id === "debug-hermes");

    expect(scrollDebug).toMatchObject({
      id: "debug-scroll",
      label: "Scroll Debug",
    });
    expect(hermesDebug).toMatchObject({
      id: "debug-hermes",
      label: "Hermes Debug",
    });

    scrollDebug!.execute();
    hermesDebug!.execute();

    expect(navigate).toHaveBeenCalledWith({ to: "/debug/scroll" });
    expect(navigate).toHaveBeenCalledWith({ to: "/debug/hermes" });
    expect(closePaletteAndRefocusMock).toHaveBeenCalledTimes(2);
  });
});
