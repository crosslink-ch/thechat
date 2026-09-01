import { act, render, screen } from "@testing-library/react";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { beforeEach, describe, expect, it } from "vitest";
import { usePermissionModeStore } from "../stores/permission-mode";
import { ChatHeader } from "./ChatHeader";

async function renderHeader(path: "/settings" | "/chat" | "/activity") {
  const rootRoute = createRootRoute();
  const childRoute = createRoute({
    getParentRoute: () => rootRoute,
    path,
    component: ChatHeader,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([childRoute]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });

  await act(async () => {
    render(<RouterProvider router={router as any} />);
  });
}

beforeEach(() => {
  usePermissionModeStore.setState({ mode: "bypass" });
});

describe("ChatHeader settings visibility", () => {
  it("does not show Agent Chat permission state on Settings", async () => {
    await renderHeader("/settings");

    expect(screen.getByText("Settings")).toBeInTheDocument();
    expect(screen.queryByText("Bypass")).not.toBeInTheDocument();
    expect(screen.queryByText("Allow Edits")).not.toBeInTheDocument();
  });

  it("keeps permission state available to the retained internal Agent Chat route", async () => {
    await renderHeader("/chat");

    expect(screen.getByText("Bypass")).toBeInTheDocument();
  });

  it("labels the cross-workspace inbox as Activity", async () => {
    await renderHeader("/activity");

    expect(screen.getByText("Activity")).toBeInTheDocument();
    expect(screen.queryByText("Bypass")).not.toBeInTheDocument();
  });
});
