import { beforeEach, expect, it, vi } from "vitest";
import type { WorkspaceWithDetails } from "@thechat/shared";

vi.mock("../platform/environment", () => ({ isWeb: true }));
const { listGet, workspaceRoute, preferenceGet } = vi.hoisted(() => ({
  listGet: vi.fn(), workspaceRoute: vi.fn(), preferenceGet: vi.fn(),
}));
vi.mock("../lib/api", () => ({ api: { workspaces: Object.assign(workspaceRoute, { list: { get: listGet } }) } }));
vi.mock("../platform/preferences", () => ({ preferences: { get: preferenceGet, set: vi.fn() } }));
import { useAuthStore } from "./auth";
import { useWorkspacesStore } from "./workspaces";
import { resetPrivateSession } from "../lib/session-boundary";

const user = { id: "alice", name: "Alice", email: "alice@example.invalid", avatar: null, type: "human" } as const;
const workspace: WorkspaceWithDetails = {
  id: "workspace-1", name: "Team", createdAt: "2026-01-01", updatedAt: "2026-01-01", members: [], channels: [],
};
const list = [{ ...workspace, role: "owner" as const }];

beforeEach(() => {
  vi.clearAllMocks();
  useAuthStore.setState({ token: null, user, loading: false });
  useWorkspacesStore.getState().reset();
  preferenceGet.mockResolvedValue(workspace.id);
  workspaceRoute.mockReturnValue({ get: vi.fn().mockResolvedValue({ data: workspace, error: null }) });
  listGet.mockResolvedValue({ data: list, error: null });
});

it("preserves a cookie session's workspaces after network failure and clears the error on retry", async () => {
  await useWorkspacesStore.getState().initialize();
  expect(listGet).toHaveBeenCalledWith({ headers: { "X-TheChat-Client": "web" } });
  listGet.mockRejectedValueOnce(new TypeError("Failed to fetch"));
  await useWorkspacesStore.getState().initialize();
  expect(useWorkspacesStore.getState()).toMatchObject({ workspaces: list, activeWorkspace: workspace, loaded: true, loading: false, error: "Unable to load workspaces." });
  await useWorkspacesStore.getState().initialize();
  expect(useWorkspacesStore.getState().error).toBeNull();
});

it("fences a delayed failure across cookie sessions even when the same user logs back in", async () => {
  let reject!: (error: Error) => void;
  listGet.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
  const request = useWorkspacesStore.getState().initialize();
  resetPrivateSession();
  useAuthStore.setState({ token: null, user, loading: false });
  await useWorkspacesStore.getState().initialize();
  reject(new Error("old session offline"));
  await request;
  expect(useWorkspacesStore.getState()).toMatchObject({ workspaces: list, activeWorkspace: workspace, loading: false, error: null });
});

it("does not surface a stale selection failure after a cookie account change", async () => {
  let reject!: (error: Error) => void;
  workspaceRoute.mockReturnValueOnce({ get: vi.fn(() => new Promise((_resolve, fail) => { reject = fail; })) });
  const selection = useWorkspacesStore.getState().selectWorkspace(workspace.id);
  resetPrivateSession();
  useAuthStore.setState({ user: { ...user, id: "bob" } });
  reject(new Error("old account offline"));
  await expect(selection).resolves.toBe(false);
  expect(useWorkspacesStore.getState()).toMatchObject({ workspaces: [], activeWorkspace: null, loaded: false, loading: false, error: null });
});
