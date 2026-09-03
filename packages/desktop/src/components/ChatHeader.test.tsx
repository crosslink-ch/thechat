import { act, render, screen } from "@testing-library/react";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { usePermissionModeStore } from "../stores/permission-mode";
import { ChatHeader, setAgentChatHeaderContext } from "./ChatHeader";

async function renderHeader(path: "/settings" | "/chat") {
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
  setAgentChatHeaderContext(null);
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

  it("shows locked ACP profile, project, connection state, and negotiated capabilities", async () => {
    setAgentChatHeaderContext({
      profiles: [
        {
          id: "profile-1",
          name: "Codex ACP",
          executable: "npx",
          args: ["-y", "@agentclientprotocol/codex-acp@1.7.0"],
          inheritEnv: [],
        },
      ],
      selectedProfileId: "profile-1",
      profileLocked: true,
      projectDir: "/workspace/thechat",
      projectLocked: true,
      status: "running",
      capabilities: {
        loadSession: true,
        prompt: { image: true, audio: false, embeddedContext: false },
        modes: true,
        configOptions: false,
        plans: false,
      },
      onSelectProfile: vi.fn(),
      onSelectProject: vi.fn(),
    });

    await renderHeader("/chat");

    expect(screen.getByRole("combobox", { name: "Agent profile" })).toHaveValue(
      "profile-1",
    );
    expect(screen.getByRole("combobox", { name: "Agent profile" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Project: /workspace/thechat" })).toBeDisabled();
    expect(screen.getByText("Running")).toBeInTheDocument();
    expect(screen.getByText("Session resume")).toBeInTheDocument();
    expect(screen.getByText("Images")).toBeInTheDocument();
    expect(screen.getByText("Modes")).toBeInTheDocument();
    expect(screen.queryByText("Audio")).not.toBeInTheDocument();
  });
});
