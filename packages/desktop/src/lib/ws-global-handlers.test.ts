import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceWithDetails } from "@thechat/shared";
import { registerGlobalWsHandlers } from "./ws-global-handlers";
import { wsEvents } from "./ws-events";
import { useAuthStore } from "../stores/auth";
import { useWorkspacesStore } from "../stores/workspaces";

const { workspacesGetMock, workspacesRouteMock } = vi.hoisted(() => {
  const getMock = vi.fn();
  return {
    workspacesGetMock: getMock,
    workspacesRouteMock: vi.fn(() => ({ get: getMock })),
  };
});

vi.mock("./api", () => ({
  api: {
    workspaces: workspacesRouteMock,
  },
}));

vi.mock("./notifications", () => ({
  fireNotification: vi.fn(),
}));

const baseWorkspace: WorkspaceWithDetails = {
  id: "ws-1",
  name: "Workspace",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  channels: [],
  members: [
    {
      userId: "u-owner",
      role: "owner",
      joinedAt: "2026-01-01T00:00:00.000Z",
      user: {
        id: "u-owner",
        name: "Owner",
        email: "owner@example.com",
        avatar: null,
        type: "human",
      },
    },
  ],
};

describe("registerGlobalWsHandlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAuthStore.setState({ token: "token-1", user: null, loading: false });
    useWorkspacesStore.setState({
      workspaces: [],
      activeWorkspace: structuredClone(baseWorkspace),
      loading: false,
    });
  });

  it("optimistically adds a joined member and refreshes workspace details", async () => {
    workspacesGetMock.mockResolvedValueOnce({
      data: {
        ...baseWorkspace,
        name: "Workspace (server)",
        members: [
          ...baseWorkspace.members,
          {
            userId: "u-bot",
            role: "member",
            joinedAt: "2026-01-02T00:00:00.000Z",
            user: {
              id: "u-bot",
              name: "Release Bot",
              email: null,
              avatar: null,
              type: "bot",
            },
          },
        ],
      },
      error: null,
    });

    const cleanup = registerGlobalWsHandlers(() => {});

    wsEvents.emit("ws:member_joined", {
      workspaceId: "ws-1",
      member: {
        userId: "u-bot",
        role: "member",
        joinedAt: "2026-01-02T00:00:00.000Z",
        user: {
          id: "u-bot",
          name: "Release Bot",
          email: null,
          avatar: null,
          type: "bot",
        },
      },
    });

    expect(
      useWorkspacesStore.getState().activeWorkspace?.members.some((m) => m.userId === "u-bot"),
    ).toBe(true);

    await Promise.resolve();
    await Promise.resolve();

    expect(workspacesRouteMock).toHaveBeenCalledWith({ id: "ws-1" });
    expect(useWorkspacesStore.getState().activeWorkspace?.name).toBe("Workspace (server)");

    cleanup();
  });
});
