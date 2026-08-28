import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthUser, WorkspaceChannel, WorkspaceWithDetails } from "@thechat/shared";
import { useAuthStore } from "./auth";
import { useWorkspacesStore } from "./workspaces";

const {
  channelRouteMock,
  channelPostMock,
  channelPatchMock,
  channelDeleteMock,
} = vi.hoisted(() => ({
  channelRouteMock: vi.fn(),
  channelPostMock: vi.fn(),
  channelPatchMock: vi.fn(),
  channelDeleteMock: vi.fn(),
}));

vi.mock("../lib/api", () => {
  const channel = Object.assign(channelRouteMock, { post: channelPostMock });
  return { api: { conversations: { channel } } };
});

const user: AuthUser = {
  id: "u1",
  name: "Owner",
  email: "owner@example.com",
  avatar: null,
  type: "human",
};

const general: WorkspaceChannel = {
  id: "ch-general",
  workspaceId: "ws-1",
  name: "general",
  title: "General",
  isPrivate: false,
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
};

const workspace: WorkspaceWithDetails = {
  id: "ws-1",
  name: "Team Alpha",
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
  channels: [general],
  members: [
    {
      userId: user.id,
      role: "owner",
      joinedAt: "2026-01-01",
      user,
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  channelRouteMock.mockReturnValue({
    patch: channelPatchMock,
    delete: channelDeleteMock,
  });
  useAuthStore.setState({ user, token: "token", loading: false });
  useWorkspacesStore.setState({
    workspaces: [],
    activeWorkspace: workspace,
    loading: false,
  });
});

describe("workspace channel actions", () => {
  it("sends private visibility and selected members when creating a channel", async () => {
    const created: WorkspaceChannel = {
      ...general,
      id: "ch-leadership",
      name: "leadership",
      title: "Leadership",
      isPrivate: true,
    };
    channelPostMock.mockResolvedValue({ data: created, error: null });

    await expect(
      useWorkspacesStore.getState().createChannel("Leadership", {
        isPrivate: true,
        memberIds: ["u2", "u3"],
      }),
    ).resolves.toEqual(created);

    expect(channelPostMock).toHaveBeenCalledWith(
      {
        workspaceId: workspace.id,
        name: "Leadership",
        isPrivate: true,
        memberIds: ["u2", "u3"],
      },
      { headers: { authorization: "Bearer token" } },
    );
  });

  it("creates, renames, and deletes channels in the active workspace", async () => {
    const created: WorkspaceChannel = {
      ...general,
      id: "ch-product",
      name: "product",
      title: "Product",
    };
    const renamed: WorkspaceChannel = {
      ...created,
      name: "product-design",
      title: "Product Design",
    };
    channelPostMock.mockResolvedValue({ data: created, error: null });
    channelPatchMock.mockResolvedValue({ data: renamed, error: null });
    channelDeleteMock.mockResolvedValue({
      data: { ok: true, deletedChannelId: created.id },
      error: null,
    });

    await expect(useWorkspacesStore.getState().createChannel("Product")).resolves.toEqual(
      created,
    );
    expect(channelPostMock).toHaveBeenCalledWith(
      { workspaceId: workspace.id, name: "Product" },
      { headers: { authorization: "Bearer token" } },
    );
    expect(useWorkspacesStore.getState().activeWorkspace?.channels).toHaveLength(2);

    await expect(
      useWorkspacesStore.getState().renameChannel(created.id, "Product Design"),
    ).resolves.toEqual(renamed);
    expect(channelRouteMock).toHaveBeenCalledWith({ conversationId: created.id });
    expect(channelPatchMock).toHaveBeenCalledWith(
      { name: "Product Design" },
      { headers: { authorization: "Bearer token" } },
    );
    expect(
      useWorkspacesStore
        .getState()
        .activeWorkspace?.channels.find((channel) => channel.id === created.id)?.name,
    ).toBe("product-design");

    await useWorkspacesStore.getState().deleteChannel(created.id);
    expect(channelDeleteMock).toHaveBeenCalledWith(undefined, {
      headers: { authorization: "Bearer token" },
    });
    expect(
      useWorkspacesStore
        .getState()
        .activeWorkspace?.channels.some((channel) => channel.id === created.id),
    ).toBe(false);
  });

  it("does not duplicate a channel when realtime wins the REST response race", async () => {
    const created: WorkspaceChannel = {
      ...general,
      id: "ch-product",
      name: "product",
      title: "Product",
    };
    useWorkspacesStore.setState({
      activeWorkspace: { ...workspace, channels: [general, created] },
    });
    channelPostMock.mockResolvedValue({ data: created, error: null });

    await useWorkspacesStore.getState().createChannel("Product");

    expect(
      useWorkspacesStore.getState().activeWorkspace?.channels.map((channel) =>
        channel.id,
      ),
    ).toEqual([general.id, created.id]);
  });

  it("surfaces the API's structured error message", async () => {
    channelPostMock.mockResolvedValue({
      data: null,
      error: { value: { error: "A channel with this name already exists" } },
    });

    await expect(
      useWorkspacesStore.getState().createChannel("General"),
    ).rejects.toThrow("A channel with this name already exists");
    expect(useWorkspacesStore.getState().activeWorkspace?.channels).toEqual([
      general,
    ]);
  });
});
