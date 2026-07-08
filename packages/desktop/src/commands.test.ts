import { describe, it, expect, vi, beforeEach } from "vitest";

const closePaletteMock = vi.fn();
const closePaletteAndRefocusMock = vi.fn();
const togglePaletteMock = vi.fn();
const openPaletteInCommandModeMock = vi.fn();
const toggleSidebarMock = vi.fn();
const openWorkspaceModalMock = vi.fn();
const openPermissionModePickerMock = vi.fn();
const openHermesBotModalMock = vi.fn();
const openMcpConfigDialogMock = vi.fn();

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

vi.mock("./PermissionModePicker", () => ({
  openPermissionModePicker: () => openPermissionModePickerMock(),
}));

vi.mock("./McpConfigDialog", () => ({
  openMcpConfigDialog: () => openMcpConfigDialogMock(),
}));

import { createCommands } from "./commands";
import { useWorkspacesStore } from "./stores/workspaces";

describe("createCommands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useWorkspacesStore.setState({
      workspaces: [],
      activeWorkspace: null,
      loading: false,
    });
  });

  it("does not expose removed creation or project-selection commands", () => {
    const commands = createCommands(vi.fn());
    const ids = commands.map((command) => command.id);
    const shortcuts = commands.map((command) => command.shortcut).filter(Boolean);
    const removedPrimaryId = ["new", "chat"].join("-");
    const removedProjectId = ["new", "chat", "in", "project"].join("-");
    const removedSelectProjectId = ["select", "project"].join("-");
    const removedPrimaryShortcut = ["C-x", "n"].join(" ");
    const removedProjectShortcut = ["C-x", "c", "n"].join(" ");

    expect(ids).not.toContain("login");
    expect(commands.map((command) => command.label)).not.toContain("Log In");
    expect(ids).not.toContain(removedPrimaryId);
    expect(ids).not.toContain(removedProjectId);
    expect(ids).not.toContain(removedSelectProjectId);
    expect(shortcuts).not.toContain(removedPrimaryShortcut);
    expect(shortcuts).not.toContain(removedProjectShortcut);
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

  it("navigates to workspace management only when a workspace is active", () => {
    const navigate = vi.fn();
    const command = createCommands(navigate).find((c) => c.id === "manage-workspace")!;

    command.execute();
    expect(navigate).not.toHaveBeenCalled();

    useWorkspacesStore.setState({
      activeWorkspace: {
        id: "ws-1",
        name: "Workspace",
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
        channels: [],
        members: [],
      },
    });

    command.execute();
    expect(navigate).toHaveBeenCalledWith({ to: "/workspace/manage" });
    expect(closePaletteAndRefocusMock).toHaveBeenCalledOnce();
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
