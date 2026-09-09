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
