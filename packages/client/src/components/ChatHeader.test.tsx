import { act, fireEvent, render, screen } from "@testing-library/react";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePermissionModeStore } from "../stores/permission-mode";
import { useWorkspacesStore } from "../stores/workspaces";
import { ChatHeader, setAgentChatTitle } from "./ChatHeader";
import { ResponsiveShell } from "./ResponsiveShell";
import { useSidebarState } from "./Sidebar";

vi.mock("../platform/environment", () => ({ isWeb: true }));
const { openChannelDetailsModalMock } = vi.hoisted(() => ({ openChannelDetailsModalMock: vi.fn() }));
vi.mock("./ChannelDetailsModal", () => ({ openChannelDetailsModal: openChannelDetailsModalMock }));

async function renderHeader(path: string, initialEntry = path) {
  const rootRoute = createRootRoute();
  const childRoute = createRoute({
    getParentRoute: () => rootRoute,
    path,
    component: () => <ResponsiveShell navigation={<p>Channels</p>} routeKey={initialEntry}><ChatHeader /></ResponsiveShell>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([childRoute]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  });

  await act(async () => {
    render(<RouterProvider router={router as any} />);
  });
}

const pages = [
  ["/", "Acme"],
  ["/settings", "Settings"],
  ["/activity", "Activity"],
  ["/notifications", "Notifications"],
  ["/workspace/manage", "Workspace settings"],
  ["/bots/manage", "Bots"],
];

beforeEach(() => {
  usePermissionModeStore.setState({ mode: "bypass" });
  useSidebarState.setState({ open: true });
  useWorkspacesStore.setState({ activeWorkspace: {
    name: "Acme", channels: [{ id: "general", name: "general" }], members: [],
  } as any });
  setAgentChatTitle("");
});
afterEach(() => vi.unstubAllGlobals());

describe("ChatHeader contextual identity", () => {
  it.each(pages)("omits the duplicate desktop heading on %s", async (path) => {
    await renderHeader(path);
    expect(document.querySelector(".chat-header")).not.toBeInTheDocument();
    expect(screen.queryByText("Bypass")).not.toBeInTheDocument();
  });

  it.each(pages)("keeps a labelled navigation entry on mobile %s", async (path, label) => {
    vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    await renderHeader(path);
    expect(screen.getByText(label)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open navigation" })).toBeInTheDocument();
    expect(screen.queryByText("Bypass")).not.toBeInTheDocument();
  });

  it("lets desktop web users recover a collapsed sidebar even on page routes", async () => {
    useSidebarState.setState({ open: false });
    await renderHeader("/settings");
    fireEvent.click(screen.getByRole("button", { name: "Open sidebar" }));
    expect(useSidebarState.getState().open).toBe(true);
    expect(document.querySelector(".chat-header")).not.toBeInTheDocument();
  });

  it("shows a channel name as the primary identity and follows renames", async () => {
    await renderHeader("/channel/$id", "/channel/general");
    expect(screen.getByText("general")).toHaveClass("font-semibold", "text-text", "truncate");
    act(() => useWorkspacesStore.setState({ activeWorkspace: {
      ...useWorkspacesStore.getState().activeWorkspace!, channels: [{ id: "general", name: "renamed" }],
    } as any }));
    expect(screen.getByText("renamed")).toBeInTheDocument();
    expect(screen.queryByText("general")).not.toBeInTheDocument();
  });

  it("marks a private channel with a lock and opens its details from the header", async () => {
    useWorkspacesStore.setState({ activeWorkspace: {
      name: "Acme",
      members: [{ userId: "u1" }, { userId: "u2" }, { userId: "u3" }],
      channels: [
        { id: "general", name: "general", isPrivate: false },
        { id: "leadership", name: "leadership", isPrivate: true, members: [{ userId: "u1", role: "admin" }, { userId: "u2", role: "member" }] },
      ],
    } as any });
    await renderHeader("/channel/$id", "/channel/leadership");
    // A private channel counts its own members, not the workspace.
    const details = screen.getByRole("button", { name: "Channel details: private channel leadership, 2 members" });
    fireEvent.click(details);
    expect(openChannelDetailsModalMock).toHaveBeenCalledWith("leadership");
  });

  it("counts the whole workspace for a public channel", async () => {
    useWorkspacesStore.setState({ activeWorkspace: {
      name: "Acme", members: [{ userId: "u1" }, { userId: "u2" }, { userId: "u3" }],
      channels: [{ id: "general", name: "general", isPrivate: false }],
    } as any });
    await renderHeader("/channel/$id", "/channel/general");
    expect(screen.getByRole("button", { name: "Channel details: general, 3 members" })).toBeInTheDocument();
  });

  it.each([['bypass', 'Bypass'], ['allow-edits', 'Allow Edits']] as const)("keeps %s warnings with the retained agent title", async (mode, label) => {
    usePermissionModeStore.setState({ mode });
    setAgentChatTitle("Fix the failing build");
    await renderHeader("/chat");
    expect(screen.getByText("Fix the failing build")).toBeInTheDocument();
    expect(screen.getByText(label)).toBeInTheDocument();
    act(() => setAgentChatTitle("Updated chat title"));
    expect(screen.getByText("Updated chat title")).toBeInTheDocument();
  });
});
