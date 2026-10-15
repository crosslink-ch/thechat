import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthUser, WorkspaceChannel, WorkspaceWithDetails } from "@thechat/shared";
import { useAuthStore } from "./auth";
import { useWorkspacesStore } from "./workspaces";

const {
  channelRouteMock,
  channelPostMock,
  channelPatchMock,
  channelDeleteMock,
  workspaceListGetMock,
  workspaceCreatePostMock,
  workspaceRouteMock,
  invokeMock,
} = vi.hoisted(() => ({
  channelRouteMock: vi.fn(),
  channelPostMock: vi.fn(),
  channelPatchMock: vi.fn(),
  channelDeleteMock: vi.fn(),
  workspaceListGetMock: vi.fn(),
  workspaceCreatePostMock: vi.fn(),
  workspaceRouteMock: vi.fn(),
  invokeMock: vi.fn(),
}));

vi.mock("../lib/api", () => {
  const channel = Object.assign(channelRouteMock, { post: channelPostMock });
  const workspaces = Object.assign(workspaceRouteMock, {
    list: { get: workspaceListGetMock },
    create: { post: workspaceCreatePostMock },
  });
  return { api: { conversations: { channel }, workspaces } };
});

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

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

const betaWorkspace: WorkspaceWithDetails = {
  ...workspace,
  id: "ws-2",
  name: "Team Beta",
  channels: [],
};

const workspaceList = [workspace, betaWorkspace].map(({ id, name, createdAt, updatedAt }) => ({
  id,
  name,
  createdAt,
  updatedAt,
  role: "owner" as const,
}));

beforeEach(() => {
  vi.clearAllMocks();
  channelRouteMock.mockReturnValue({
    patch: channelPatchMock,
    delete: channelDeleteMock,
  });
  workspaceListGetMock.mockResolvedValue({ data: workspaceList, error: null });
  workspaceRouteMock.mockImplementation(({ id }) => ({
    get: vi.fn().mockResolvedValue({
      data: id === workspace.id ? workspace : betaWorkspace,
      error: null,
    }),
  }));
  invokeMock.mockImplementation((command: string) =>
    Promise.resolve(command === "kv_get" ? workspace.id : undefined),
  );
  useAuthStore.setState({ user, token: "token", loading: false });
  useWorkspacesStore.setState({
    workspaces: [],
    activeWorkspace: workspace,
    loading: false,
    loaded: false,
    error: null,
  });
});

describe("workspace loading failures", () => {
  it("keeps the selected workspace when refreshing its details fails", async () => {
    useWorkspacesStore.setState({ workspaces: workspaceList, error: null });
    workspaceRouteMock.mockReturnValue({
      get: vi.fn().mockResolvedValue({ data: null, error: { status: 503 } }),
    });
    await useWorkspacesStore.getState().initialize();
    expect(useWorkspacesStore.getState().activeWorkspace).toEqual(workspace);
    expect(useWorkspacesStore.getState().error).toBe("Unable to load workspaces.");
  });

  it("distinguishes a failed initial load from a successful empty retry", async () => {
    useWorkspacesStore.getState().reset();
    workspaceListGetMock.mockResolvedValueOnce({ data: null, error: { status: 503 } });
    await useWorkspacesStore.getState().initialize();
    expect(useWorkspacesStore.getState().loaded).toBe(false);
    expect(useWorkspacesStore.getState().error).toBe("Unable to load workspaces.");

    workspaceListGetMock.mockResolvedValueOnce({ data: [], error: null });
    await useWorkspacesStore.getState().initialize();
    expect(useWorkspacesStore.getState().loaded).toBe(true);
    expect(useWorkspacesStore.getState().error).toBeNull();
    expect(useWorkspacesStore.getState().workspaces).toEqual([]);
    expect(useWorkspacesStore.getState().activeWorkspace).toBeNull();
  });

  it("clears cached selection when a successful response removes its workspace", async () => {
    workspaceListGetMock.mockResolvedValueOnce({ data: [], error: null });
    await useWorkspacesStore.getState().initialize();
    expect(useWorkspacesStore.getState().activeWorkspace).toBeNull();
  });
  it("reports list failure without erasing the last workspace list or selection", async () => {
    useWorkspacesStore.setState({ workspaces: workspaceList });
    workspaceListGetMock.mockRejectedValueOnce(new Error("Network unavailable"));

    await useWorkspacesStore.getState().initialize();

    expect(useWorkspacesStore.getState().workspaces).toEqual(workspaceList);
    expect(useWorkspacesStore.getState().activeWorkspace).toEqual(workspace);
    expect(useWorkspacesStore.getState().error).toBe("Unable to load workspaces.");
    expect(useWorkspacesStore.getState().loading).toBe(false);
  });
});

describe("workspace selection races", () => {
  it("does not let recovery initialization interrupt a pending explicit selection", async () => {
    let resolveSelection!: (value: unknown) => void;
    workspaceRouteMock.mockReturnValueOnce({
      get: vi.fn().mockImplementation(() => new Promise((resolve) => { resolveSelection = resolve; })),
    });
    const selecting = useWorkspacesStore.getState().selectWorkspace(betaWorkspace.id);
    await useWorkspacesStore.getState().initialize();
    resolveSelection({ data: betaWorkspace, error: null });
    await expect(selecting).resolves.toBe(true);
    expect(useWorkspacesStore.getState().activeWorkspace).toEqual(betaWorkspace);
    expect(workspaceListGetMock).not.toHaveBeenCalled();
    // Once selection is finished, subsequent recovery can load normally.
    await useWorkspacesStore.getState().initialize();
    expect(workspaceListGetMock).toHaveBeenCalledOnce();
  });

  it("reports a selection failure and clears it after an explicit successful retry", async () => {
    workspaceRouteMock.mockReturnValueOnce({ get: vi.fn().mockRejectedValue(new Error("offline")) });
    await expect(useWorkspacesStore.getState().selectWorkspace(betaWorkspace.id)).resolves.toBe(false);
    expect(useWorkspacesStore.getState().activeWorkspace).toEqual(workspace);
    expect(useWorkspacesStore.getState().error).toBe("Unable to load workspace.");
    await expect(useWorkspacesStore.getState().selectWorkspace(betaWorkspace.id)).resolves.toBe(true);
    expect(useWorkspacesStore.getState().error).toBeNull();
    expect(useWorkspacesStore.getState().activeWorkspace).toEqual(betaWorkspace);
  });

  it("ignores an old account's list failure even if its token has not changed", async () => {
    let reject!: (error: Error) => void;
    workspaceListGetMock.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    const request = useWorkspacesStore.getState().initialize();
    useAuthStore.setState({ user: { ...user, id: "other-user" } });
    reject(new Error("late failure"));
    await request;
    expect(useWorkspacesStore.getState().error).toBeNull();
  });

  it.each(["success", "failure"])("fences a late %s after reset", async (outcome) => {
    let resolve!: (value: unknown) => void;
    let reject!: (error: Error) => void;
    workspaceListGetMock.mockImplementationOnce(() => new Promise((ok, fail) => { resolve = ok; reject = fail; }));
    const request = useWorkspacesStore.getState().initialize();
    useWorkspacesStore.getState().reset();
    if (outcome === "success") resolve({ data: workspaceList, error: null });
    else reject(new Error("late failure"));
    await request;
    expect(useWorkspacesStore.getState()).toMatchObject({ workspaces: [], activeWorkspace: null, loaded: false, loading: false, error: null });
  });

  it("does not let an older failed refresh overwrite a newer success", async () => {
    let reject!: (error: Error) => void;
    workspaceListGetMock.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    const oldRequest = useWorkspacesStore.getState().initialize();
    await useWorkspacesStore.getState().initialize();
    reject(new Error("late failure"));
    await oldRequest;
    expect(useWorkspacesStore.getState()).toMatchObject({ workspaces: workspaceList, activeWorkspace: workspace, loading: false, error: null });
  });

  it("does not let slow initialization undo an explicit Activity selection", async () => {
    let resolveList!: (value: unknown) => void;
    workspaceListGetMock.mockImplementationOnce(
      () => new Promise((resolve) => {
        resolveList = resolve;
      }),
    );

    const initializing = useWorkspacesStore.getState().initialize();
    await vi.waitFor(() => expect(workspaceListGetMock).toHaveBeenCalledTimes(1));

    await expect(
      useWorkspacesStore.getState().selectWorkspace(betaWorkspace.id),
    ).resolves.toBe(true);
    resolveList({ data: workspaceList, error: null });
    await initializing;

    expect(useWorkspacesStore.getState().activeWorkspace?.id).toBe(
      betaWorkspace.id,
    );
    expect(workspaceRouteMock).not.toHaveBeenCalledWith({
      id: workspace.id,
    });
  });
});

describe("successful workspace creation during a read outage", () => {
  it.each([false, true])("does not fail creation or repeat its POST when reconciliation fails (details fail: %s)", async (detailsFail) => {
    useWorkspacesStore.setState({ workspaces: [workspaceList[0]], loaded: true });
    const { id, name, createdAt, updatedAt } = betaWorkspace;
    workspaceCreatePostMock.mockResolvedValueOnce({ data: { id, name, createdAt, updatedAt }, error: null });
    if (detailsFail) workspaceRouteMock.mockReturnValueOnce({ get: vi.fn().mockRejectedValue(new Error("read outage")) });
    else workspaceListGetMock.mockRejectedValueOnce(new Error("read outage"));
    let savedId = workspace.id;
    invokeMock.mockImplementation((command: string, args: { key?: string; value?: string }) => {
      if (command === "kv_set" && args.key === "active_workspace_id") savedId = args.value!;
      return Promise.resolve(command === "kv_get" ? savedId : undefined);
    });
    await expect(useWorkspacesStore.getState().createWorkspace(name)).resolves.toBeUndefined();
    expect(workspaceCreatePostMock).toHaveBeenCalledOnce();
    expect(useWorkspacesStore.getState().workspaces).toContainEqual(workspaceList[1]);
    expect(useWorkspacesStore.getState().error).not.toBeNull();
    expect(savedId).toBe(id);
    await useWorkspacesStore.getState().initialize();
    expect(workspaceCreatePostMock).toHaveBeenCalledOnce();
    expect(useWorkspacesStore.getState().activeWorkspace).toEqual(betaWorkspace);
    expect(useWorkspacesStore.getState().error).toBeNull();
  });
});

describe("workspace channel actions", () => {
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
