import { describe, it, expect, beforeEach } from "vitest";
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

beforeEach(() => {
  useWorkspacesStore.setState({
    workspaces: [],
    activeWorkspace: null,
    loading: false,
  });
});

describe("WorkspaceHomeRoute", () => {
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
});
