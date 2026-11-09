import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, waitFor, within } from "@testing-library/react";
import type { MessageSearchHit, MessageSearchPage, SearchDestination } from "@thechat/shared";

const searchApi = vi.hoisted(() => ({
  fetchSearchDirectory: vi.fn(),
  fetchMessageSearch: vi.fn(),
  fetchDestinations: vi.fn(),
}));
vi.mock("./lib/search-api", () => ({ ...searchApi, SearchRequestError: class extends Error {} }));

const navigation = vi.hoisted(() => ({
  openSearchDestination: vi.fn(),
  openSearchMessage: vi.fn(),
  searchNavigate: vi.fn(),
}));
vi.mock("./lib/search-navigation", () => ({
  ...navigation,
  JumpSupersededError: class extends Error {},
}));

import { createCommands, useCommandsStore, type Command } from "./commands";
import {
  CommandPalette,
  closePalette,
  openMessageSearch,
  openPaletteInCommandMode,
  togglePalette,
} from "./CommandPalette";
import { useSearchDirectoryStore } from "./stores/search-directory";
import { useRecentLocationsStore } from "./stores/recent-locations";
import { useWorkspacesStore } from "./stores/workspaces";
import { clearMessageSearchCache } from "./hooks/useMessageSearch";

function makeCommand(overrides: Partial<Command> & { id: string; label: string }): Command {
  return { shortcut: null, keybinding: null, execute: vi.fn(), ...overrides };
}

function makeTestCommands(): Command[] {
  return [
    makeCommand({ id: "toggle-sidebar", label: "Toggle Sidebar" }),
    makeCommand({ id: "workspace", label: "Workspace", shortcut: "Ctrl+L" }),
    makeCommand({ id: "settings", label: "Settings", shortcut: "C-x ," }),
  ];
}

const W1 = { workspaceId: "w1", workspaceName: "Cross-Link" };
const W2 = { workspaceId: "w2", workspaceName: "TouchPoint" };

const koda: SearchDestination = {
  kind: "person", userId: "u-koda", name: "Koda", userType: "bot", botKind: "hermes",
  botAvatar: null, conversationId: "dm-koda", ...W1,
};
const simon: SearchDestination = {
  kind: "person", userId: "u-simon", name: "Simon", userType: "human", botKind: null,
  botAvatar: null, conversationId: null, ...W1,
};
const general: SearchDestination = { kind: "channel", conversationId: "ch-general", name: "general", ...W1 };
const releases: SearchDestination = { kind: "channel", conversationId: "ch-releases", name: "releases", ...W2 };
const invoiceTask: SearchDestination = {
  kind: "task", conversationId: "dm-koda", conversationName: "Koda", threadId: "t-invoice",
  title: "Invoice cleanup", lastActivityAt: "2026-11-01T10:00:00.000Z", ...W1,
};
const directory = [general, releases, koda, simon, invoiceTask];

function hit(id: string, snippet: string): MessageSearchHit {
  return {
    id, conversationId: "ch-general", conversationType: "group", conversationName: "general",
    threadId: null, threadTitle: null, senderId: "u-simon", senderName: "Simon", senderType: "human",
    snippet, createdAt: "2026-11-05T10:00:00.000Z", ...W1,
  };
}

async function open(action: () => void = togglePalette) {
  let result!: ReturnType<typeof render>;
  await act(async () => {
    result = render(<CommandPalette />);
  });
  await act(async () => action());
  return result;
}

const input = () => screen.getByRole("textbox", { name: "Search TheChat" });
const type = (text: string) => fireEvent.change(input(), { target: { value: text } });
const press = (key: string, init: Partial<KeyboardEventInit> = {}) => fireEvent.keyDown(input(), { key, ...init });
const rows = () => screen.queryAllByTestId("palette-item");
const activeRow = () => rows().find((row) => row.dataset.active === "true");

beforeEach(() => {
  vi.clearAllMocks();
  clearMessageSearchCache();
  closePalette();
  useCommandsStore.setState({ globalCommands: [], scopedCommands: {}, commands: [] });
  useSearchDirectoryStore.setState({
    destinations: directory, loaded: true, loading: false, error: null, loadedAt: Date.now(),
  });
  useRecentLocationsStore.setState({ userId: "me", keys: [], current: null });
  useWorkspacesStore.setState({
    workspaces: [
      { id: "w1", name: "Cross-Link", role: "member" } as never,
      { id: "w2", name: "TouchPoint", role: "member" } as never,
    ],
    activeWorkspace: { id: "w1", name: "Cross-Link", channels: [], members: [] } as never,
  });
  searchApi.fetchSearchDirectory.mockResolvedValue(directory);
  searchApi.fetchDestinations.mockResolvedValue([]);
  searchApi.fetchMessageSearch.mockResolvedValue({ results: [], nextCursor: null } satisfies MessageSearchPage);
  navigation.openSearchDestination.mockResolvedValue(undefined);
  navigation.openSearchMessage.mockResolvedValue(undefined);
  navigation.searchNavigate.mockResolvedValue(undefined);
});

afterEach(() => closePalette());

describe("command mode (Ctrl+Shift+P)", () => {
  it("lists visible commands and hides hidden ones", async () => {
    useCommandsStore.getState().setCommands([
      ...makeTestCommands(),
      makeCommand({ id: "hidden", label: "Hidden Command", shortcut: "Ctrl+H", hidden: true }),
    ]);
    await open(openPaletteInCommandMode);
    expect(screen.getByPlaceholderText("Type a command...")).toBeInTheDocument();
    expect(screen.getByText("Toggle Sidebar")).toBeInTheDocument();
    expect(screen.queryByText("Hidden Command")).not.toBeInTheDocument();
    expect(screen.queryByText("Ctrl+H")).not.toBeInTheDocument();
  });

  it("filters, shows shortcut badges only where set, and an empty state", async () => {
    useCommandsStore.getState().setCommands(makeTestCommands());
    const { container } = await open(openPaletteInCommandMode);
    const kbds = Array.from(container.querySelectorAll("[data-testid='palette-item'] kbd")).map((element) => element.textContent);
    expect(kbds).toEqual(["Ctrl+L", "C-x ,"]);
    type("settings");
    expect(screen.getByText("Settings")).toBeInTheDocument();
    expect(screen.queryByText("Toggle Sidebar")).not.toBeInTheDocument();
    type("zzzzz");
    expect(screen.getByText("No matching commands")).toBeInTheDocument();
  });

  it("runs the highlighted command with arrows and Enter, or by click", async () => {
    const commands = makeTestCommands();
    useCommandsStore.getState().setCommands(commands);
    await open(openPaletteInCommandMode);
    press("Enter");
    expect(commands[0]!.execute).toHaveBeenCalledOnce();
    press("ArrowDown");
    press("Enter");
    expect(commands[1]!.execute).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByText("Settings"));
    expect(commands[2]!.execute).toHaveBeenCalledOnce();
  });

  it("opens the restored workspace management entrypoint", async () => {
    const navigate = vi.fn();
    useCommandsStore.getState().setCommands(createCommands(navigate));
    await open(openPaletteInCommandMode);
    fireEvent.click(screen.getByText("Manage Workspace"));
    expect(navigate).toHaveBeenCalledWith({ to: "/workspace/manage" });
  });

  it("is also reachable with a leading > from the quick switcher", async () => {
    useCommandsStore.getState().setCommands(makeTestCommands());
    await open();
    type(">sett");
    expect(rows().map((row) => row.getAttribute("aria-label"))).toEqual(["Settings"]);
  });

  it("Escape and the backdrop close it", async () => {
    await open(openPaletteInCommandMode);
    press("Escape");
    expect(screen.queryByTestId("palette-panel")).not.toBeInTheDocument();
    await act(async () => openPaletteInCommandMode());
    fireEvent.click(screen.getByTestId("palette-panel").parentElement!);
    expect(screen.queryByTestId("palette-panel")).not.toBeInTheDocument();
  });
});

describe("quick switcher (Ctrl+K)", () => {
  it("finds a loosely typed name across workspaces and opens it with Enter", async () => {
    await open();
    type("kda");
    expect(activeRow()).toHaveAccessibleName("Koda, Hermes agent, Cross-Link");
    press("Enter");
    await waitFor(() => expect(navigation.openSearchDestination).toHaveBeenCalledWith(koda));
    await waitFor(() => expect(screen.queryByTestId("palette-panel")).not.toBeInTheDocument());
  });

  it("ranks an exact name over a recently visited partial match", async () => {
    useRecentLocationsStore.setState({ keys: ["ch-releases"] });
    useSearchDirectoryStore.setState({
      destinations: [...directory, { kind: "channel", conversationId: "ch-rel", name: "rel", ...W1 }],
    });
    await open();
    type("rel");
    expect(activeRow()).toHaveAccessibleName("rel, channel, Cross-Link");
  });

  it("finds Hermes tasks by title and says whose task it is", async () => {
    await open();
    type("invoice");
    expect(activeRow()).toHaveAccessibleName("Invoice cleanup, task in Koda, Cross-Link");
  });

  it("lists recent places first when nothing is typed", async () => {
    useRecentLocationsStore.setState({ keys: ["dm-koda:t-invoice", "ch-releases"] });
    await open();
    expect(rows().map((row) => row.getAttribute("aria-label"))).toEqual([
      "Invoice cleanup, task in Koda, Cross-Link",
      "releases, channel, TouchPoint",
    ]);
  });

  it("narrows with @ and # prefixes and with the filter buttons", async () => {
    await open();
    type("@");
    expect(rows().map((row) => row.getAttribute("aria-label"))).toEqual([
      "Koda, Hermes agent, Cross-Link",
      "Simon, person, Cross-Link",
    ]);
    type("#");
    expect(rows().length).toBe(2);
    expect(rows().every((row) => row.getAttribute("aria-label")!.includes("channel"))).toBe(true);
    type("");
    fireEvent.click(screen.getByRole("button", { name: "Tasks" }));
    expect(rows().map((row) => row.getAttribute("aria-label"))).toEqual([
      "Invoice cleanup, task in Koda, Cross-Link",
    ]);
  });

  it("Tab cycles the filters", async () => {
    await open();
    press("Tab");
    expect(screen.getByRole("button", { name: "People" })).toHaveAttribute("aria-pressed", "true");
    press("Tab", { shiftKey: true });
    expect(screen.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "true");
  });

  it("adds message previews below places without moving the selection", async () => {
    let resolve!: (page: MessageSearchPage) => void;
    searchApi.fetchMessageSearch.mockReturnValue(new Promise((done) => (resolve = done)));
    await open();
    type("koda");
    expect(activeRow()).toHaveAccessibleName("Koda, Hermes agent, Cross-Link");
    press("ArrowDown");
    const selected = activeRow()!.getAttribute("aria-label");
    await waitFor(() => expect(searchApi.fetchMessageSearch).toHaveBeenCalled());
    expect(searchApi.fetchMessageSearch.mock.calls[0]![0]).toMatchObject({ q: "koda", limit: 4 });
    await act(async () => resolve({ results: [hit("m1", "ask koda about invoices")], nextCursor: null }));
    const messages = screen.getByRole("group", { name: "Messages" });
    expect(within(messages).getAllByTestId("palette-item")[0]).toHaveAccessibleName(
      "Message from Simon in #general: ask koda about invoices",
    );
    expect(activeRow()!.getAttribute("aria-label")).toBe(selected);
  });

  it("filters names on the device and debounces the one message request", async () => {
    await open();
    type("s");
    type("si");
    type("sim");
    expect(activeRow()).toHaveAccessibleName("Simon, person, Cross-Link");
    await waitFor(() => expect(searchApi.fetchMessageSearch).toHaveBeenCalledTimes(1));
    expect(searchApi.fetchMessageSearch.mock.calls[0]![0]).toMatchObject({ q: "sim" });
    expect(searchApi.fetchSearchDirectory).not.toHaveBeenCalled();
  });

  it("waits for the places to load instead of searching messages on an early Enter", async () => {
    let resolve!: (destinations: SearchDestination[]) => void;
    searchApi.fetchSearchDirectory.mockReturnValue(new Promise((done) => (resolve = done)));
    useSearchDirectoryStore.setState({ destinations: [], loaded: false, loadedAt: 0 });
    await open();
    type("releases");
    press("Enter");
    expect(navigation.openSearchDestination).not.toHaveBeenCalled();
    expect(navigation.searchNavigate).not.toHaveBeenCalled();
    expect(screen.getByTestId("palette-busy")).toBeInTheDocument();
    await act(async () => resolve(directory));
    await waitFor(() => expect(navigation.openSearchDestination).toHaveBeenCalledWith(releases));
    expect(navigation.searchNavigate).not.toHaveBeenCalled();
  });

  it("shows why a jump failed and stays open", async () => {
    navigation.openSearchDestination.mockRejectedValue(new Error("Could not open that workspace"));
    await open();
    type("releases");
    press("Enter");
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not open that workspace");
    expect(screen.getByTestId("palette-panel")).toBeInTheDocument();
  });
});

describe("message search (Ctrl+Shift+F)", () => {
  it("pages through results and opens one in context", async () => {
    searchApi.fetchMessageSearch
      .mockResolvedValueOnce({ results: [hit("m1", "release notes v1"), hit("m2", "release notes v2")], nextCursor: "c1" })
      .mockResolvedValueOnce({ results: [hit("m3", "release notes v3")], nextCursor: null });
    await open(() => openMessageSearch("release notes"));
    await waitFor(() => expect(rows()).toHaveLength(3));
    expect(rows()[2]).toHaveAccessibleName("Load more results");
    fireEvent.click(rows()[2]!);
    await waitFor(() =>
      expect(rows().map((row) => row.dataset.paletteKey)).toEqual(["message:m1", "message:m2", "message:m3"]),
    );
    expect(searchApi.fetchMessageSearch.mock.calls[1]![0]).toMatchObject({ q: "release notes", cursor: "c1" });
    fireEvent.click(rows()[2]!);
    await waitFor(() => expect(navigation.openSearchMessage).toHaveBeenCalledWith(expect.objectContaining({ id: "m3" })));
  });

  it("can stay inside the conversation on screen", async () => {
    useRecentLocationsStore.setState({ current: { conversationId: "ch-general", type: "group", threadId: null } });
    useWorkspacesStore.setState({
      activeWorkspace: { id: "w1", name: "Cross-Link", channels: [{ id: "ch-general", name: "general" }], members: [] } as never,
    });
    await open(() => openMessageSearch("deploy"));
    const scope = screen.getByRole("button", { name: "Limit to #general" });
    expect(scope).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(scope);
    expect(screen.getByRole("button", { name: "✓ Only in #general" })).toHaveAttribute("aria-pressed", "true");
    await waitFor(() =>
      expect(searchApi.fetchMessageSearch).toHaveBeenLastCalledWith(
        expect.objectContaining({ q: "deploy", conversationId: "ch-general" }),
        expect.anything(),
      ),
    );
  });

  it("explains a too-short query instead of searching", async () => {
    await open(() => openMessageSearch("x"));
    expect(screen.getByText("Type at least 2 characters to search messages")).toBeInTheDocument();
    expect(searchApi.fetchMessageSearch).not.toHaveBeenCalled();
  });
});
