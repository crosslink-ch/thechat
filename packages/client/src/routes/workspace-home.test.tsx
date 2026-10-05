import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { render, screen, act, waitFor } from "@testing-library/react";
import {
  RouterProvider,
  Outlet,
  createMemoryHistory,
  createRouter,
  createRootRoute,
  createRoute,
} from "@tanstack/react-router";
import { WorkspaceHomeRoute } from "./workspace-home";
import { useWorkspacesStore } from "../stores/workspaces";
import type { WorkspaceWithDetails } from "@thechat/shared";

const activeWorkspace: WorkspaceWithDetails = {
  id: "ws-1",
  name: "Team Alpha",
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
  members: [],
  channels: [
    {
      id: "ch-1",
      workspaceId: "ws-1",
      name: "general",
      title: "General",
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
    },
  ],
};

async function renderHome(initialEntry = "/") {
  const rootRoute = createRootRoute({
    component: () => <Outlet />,
  });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: WorkspaceHomeRoute,
  });
  const channelRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/channel/$id",
    component: () => <div>Channel route</div>,
  });
  const manageRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/workspace/manage",
    component: () => <div>Manage route</div>,
  });
  const routeTree = rootRoute.addChildren([indexRoute, channelRoute, manageRoute]);
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  });

  let result!: ReturnType<typeof render>;
  await act(async () => {
    result = render(<RouterProvider router={router as any} />);
  });
  return result;
}

const initializeWorkspaces = useWorkspacesStore.getState().initialize;
const selectWorkspace = useWorkspacesStore.getState().selectWorkspace;

beforeEach(() => {
  useWorkspacesStore.setState({
    initialize: initializeWorkspaces,
    selectWorkspace,
    workspaces: [],
    activeWorkspace: null,
    loading: false,
    loaded: true,
    error: null,
  });
});

afterEach(() => vi.restoreAllMocks());

describe("WorkspaceHomeRoute", () => {
  it("does not show creation before the first list response", async () => {
    useWorkspacesStore.setState({ loaded: false });
    await renderHome();
    expect(screen.getByText("Loading workspace...")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create workspace" })).not.toBeInTheDocument();
  });

  it("does not automatically retry a failed single-workspace selection on new list references", async () => {
    const list = [{ id: "ws-1", name: "Team Alpha", role: "owner" as const, createdAt: "2026-01-01", updatedAt: "2026-01-01" }];
    useWorkspacesStore.setState({ workspaces: list, error: "Unable to load workspace." });
    const select = vi.spyOn(useWorkspacesStore.getState(), "selectWorkspace").mockResolvedValue(false);
    await renderHome();
    await act(async () => { useWorkspacesStore.setState({ workspaces: [...list] }); });
    expect(select).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });
  it("shows a retryable loading error instead of pretending the workspace list is empty", async () => {
    useWorkspacesStore.setState({ loaded: false, error: "Unable to load workspaces." });
    const initialize = vi.spyOn(useWorkspacesStore.getState(), "initialize").mockImplementation(async () => {
      useWorkspacesStore.setState({ error: null, loaded: true });
    });
    await renderHome();
    expect(screen.getByRole("alert")).toHaveTextContent("Unable to load workspaces.");
    expect(screen.queryByRole("button", { name: "Create workspace" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(initialize).toHaveBeenCalledOnce();
    expect(await screen.findByRole("button", { name: "Create workspace" })).toBeInTheDocument();
  });

  it("routes an active workspace to its first channel", async () => {
    useWorkspacesStore.setState({
      workspaces: [{ id: "ws-1", name: "Team Alpha", role: "owner", createdAt: "2026-01-01", updatedAt: "2026-01-01" }],
      activeWorkspace,
      loading: false,
    });

    await renderHome();

    await waitFor(() => {
      expect(screen.getByText("Channel route")).toBeInTheDocument();
    });
  });

  it("shows workspace creation when the user has no workspace", async () => {
    await renderHome();

    expect(screen.getByText("Workspace")).toBeInTheDocument();
    expect(screen.getByText("Create workspace")).toBeInTheDocument();
    expect(screen.queryByText("Channel route")).not.toBeInTheDocument();
  });

  it("exposes workspace access management when the active workspace has no channels", async () => {
    useWorkspacesStore.setState({
      workspaces: [{ id: "ws-1", name: "Team Alpha", role: "owner", createdAt: "2026-01-01", updatedAt: "2026-01-01" }],
      activeWorkspace: { ...activeWorkspace, channels: [] },
      loading: false,
    });

    await renderHome();

    expect(screen.getByText("This workspace has no channels yet.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Manage workspace" })).toBeInTheDocument();
  });
});
