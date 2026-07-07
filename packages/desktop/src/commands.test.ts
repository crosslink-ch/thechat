import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Conversation } from "./core/types";

const closePaletteMock = vi.fn();
const closePaletteAndRefocusMock = vi.fn();
const togglePaletteMock = vi.fn();
const openPaletteInCommandModeMock = vi.fn();
const toggleSidebarMock = vi.fn();
const openAuthModalMock = vi.fn();
const openWorkspaceModalMock = vi.fn();
const getAgentChatProjectDirMock = vi.fn<() => string | null>();
const openPermissionModePickerMock = vi.fn();
const openSelectProjectPickerMock = vi.fn();
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

vi.mock("./components/AuthModal", () => ({
  openAuthModal: () => openAuthModalMock(),
}));

vi.mock("./components/WorkspaceModal", () => ({
  openWorkspaceModal: () => openWorkspaceModalMock(),
}));

vi.mock("./components/HermesBotModal", () => ({
  openHermesBotModal: () => openHermesBotModalMock(),
}));

vi.mock("./components/ChatHeader", () => ({
  getAgentChatProjectDir: () => getAgentChatProjectDirMock(),
}));

vi.mock("./PermissionModePicker", () => ({
  openPermissionModePicker: () => openPermissionModePickerMock(),
}));

vi.mock("./SelectProjectPicker", () => ({
  openSelectProjectPicker: (...args: unknown[]) => openSelectProjectPickerMock(...args),
}));

import { createCommands } from "./commands";
import { useConversationsStore } from "./stores/conversations";

describe("createCommands - Select Project", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useConversationsStore.setState({
      conversations: [],
      unreadAgentChats: new Set(),
      unreadChannels: new Set(),
    });
    getAgentChatProjectDirMock.mockReturnValue(null);
  });

  it("opens picker with deduped recents plus current project, then navigates with selected project", () => {
    const conversations: Conversation[] = [
      { id: "1", title: "A", project_dir: "/repo/a", created_at: "", updated_at: "" },
      { id: "2", title: "B", project_dir: "/repo/b", created_at: "", updated_at: "" },
      { id: "3", title: "A2", project_dir: "/repo/a", created_at: "", updated_at: "" },
      { id: "4", title: "No project", project_dir: null, created_at: "", updated_at: "" },
    ];
    useConversationsStore.setState({ conversations });
    getAgentChatProjectDirMock.mockReturnValue("/repo/current");

    const navigate = vi.fn();
    const selectProject = createCommands(navigate).find((c) => c.id === "select-project");

    expect(selectProject).toBeDefined();
    selectProject!.execute();

    expect(closePaletteMock).toHaveBeenCalledOnce();
    expect(openSelectProjectPickerMock).toHaveBeenCalledOnce();

    const [recentProjects, onSelect] = openSelectProjectPickerMock.mock.calls[0] as [
      string[],
      (projectDir: string) => void,
    ];

    expect(recentProjects).toEqual(["/repo/current", "/repo/a", "/repo/b"]);

    onSelect("/repo/custom");

    expect(navigate).toHaveBeenCalledWith({ to: "/chat", search: { projectDir: "/repo/custom" } });
  });

  it("does not duplicate current project when it already exists in recents", () => {
    useConversationsStore.setState({
      conversations: [
        { id: "1", title: "Current", project_dir: "/repo/current", created_at: "", updated_at: "" },
        { id: "2", title: "Other", project_dir: "/repo/other", created_at: "", updated_at: "" },
      ],
    });
    getAgentChatProjectDirMock.mockReturnValue("/repo/current");

    const navigate = vi.fn();
    const selectProject = createCommands(navigate).find((c) => c.id === "select-project")!;
    selectProject.execute();

    const [recentProjects] = openSelectProjectPickerMock.mock.calls[0] as [string[], unknown];
    expect(recentProjects).toEqual(["/repo/current", "/repo/other"]);
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
